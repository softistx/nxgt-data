import type { RedisClient } from 'bun';

/** What a channel keeps: its listeners, and the SUBSCRIBE that serves them. */
interface Entry {
	readonly listeners: Set<(message: string) => void>;
	readonly ready: Promise<void>;
}

/** A client's one subscriber connection and the channels riding on it. */
interface Shared {
	readonly connection: Promise<RedisClient>;
	readonly channels: Map<string, Entry>;
	/** The UNSUBSCRIBE of a channel still in flight, which a new SUBSCRIBE follows. */
	readonly leaving: Map<string, Promise<void>>;
}

const shared = new WeakMap<RedisClient, Shared>();

/** Opens the client's subscriber connection: a duplicate, which is Redis's rule. */
function open(client: RedisClient): Shared {
	const state: Shared = {
		connection: (async () => {
			const subscriber = await client.duplicate();
			await subscriber.connect();
			return subscriber;
		})(),
		channels: new Map(),
		leaving: new Map(),
	};
	// A failed open is reported to every listen waiting on it; none waiting
	// must not become an unhandled rejection.
	state.connection.catch(() => {
		if (shared.get(client) === state) shared.delete(client);
	});
	return state;
}

/** Starts the SUBSCRIBE of a channel that has no listener yet. */
function subscribeTo(state: Shared, channel: string): Entry {
	const listeners = new Set<(message: string) => void>();
	const ready = (async () => {
		const subscriber = await state.connection;
		await state.leaving.get(channel)?.catch(() => undefined);
		await subscriber.subscribe(channel, (message: string) => {
			for (const listener of [...listeners]) {
				// One listener's throw reaches neither the others nor the connection.
				try {
					listener(message);
				} catch {}
			}
		});
	})();
	return { listeners, ready };
}

/**
 * Drops a channel nobody listens to; closes the connection when none is left.
 * It never rejects: a failed UNSUBSCRIBE or close leaves nothing for the
 * caller to do, and the connection is on its way out either way.
 */
async function leave(
	client: RedisClient,
	state: Shared,
	channel: string,
	entry: Entry,
): Promise<void> {
	state.channels.delete(channel);
	const current = shared.get(client) === state;
	if (state.channels.size === 0) {
		if (!current) return;
		// Out of the map first, so a listen arriving from now on opens its own.
		shared.delete(client);
		await entry.ready.catch(() => undefined);
		// A pending UNSUBSCRIBE of another channel must finish before the close
		// that would kill it.
		await Promise.all(
			[...state.leaving.values()].map((p) => p.catch(() => undefined)),
		);
		try {
			(await state.connection).close();
		} catch {}
		return;
	}
	const leaving = (async () => {
		try {
			await entry.ready.catch(() => undefined);
			await (await state.connection).unsubscribe(channel);
		} catch {}
	})();
	state.leaving.set(channel, leaving);
	await leaving;
	if (state.leaving.get(channel) === leaving) state.leaving.delete(channel);
}

/**
 * Hears a channel through the client's one shared subscriber connection.
 *
 * The first listen on a client opens a single duplicate, whatever the number
 * of queues bound to it; each channel is subscribed once however many
 * listeners it has. Resolves once Redis confirmed the SUBSCRIBE, so a publish
 * right after the `await` is heard. A listener that throws reaches neither
 * the others nor the connection. A connection the server drops is not
 * resubscribed here: a caller that must not miss an outcome re-reads state
 * itself (`finished()` does).
 *
 * Resolves with the function that removes this listener: it unsubscribes a
 * channel left with none, closes the connection when the client has no
 * listener left, and is a no-op the second time. It never rejects: a failed
 * UNSUBSCRIBE or close is swallowed.
 */
export async function listen(
	client: RedisClient,
	channel: string,
	listener: (message: string) => void,
): Promise<() => Promise<void>> {
	const state = shared.get(client) ?? open(client);
	shared.set(client, state);
	let entry = state.channels.get(channel);
	if (!entry) {
		entry = subscribeTo(state, channel);
		state.channels.set(channel, entry);
	}
	const mine = entry;
	// A distinct function per call, so the same listener may be added twice.
	const own = (message: string) => listener(message);
	mine.listeners.add(own);

	let leaving: Promise<void> | undefined;
	const unlisten = () => {
		leaving ??= (async () => {
			mine.listeners.delete(own);
			if (mine.listeners.size === 0 && state.channels.get(channel) === mine) {
				await leave(client, state, channel, mine);
			}
		})();
		return leaving;
	};

	try {
		await mine.ready;
	} catch (error) {
		await unlisten().catch(() => undefined);
		throw error;
	}
	return unlisten;
}

/**
 * Waits until every message already on its way to the client's subscriber
 * connection has reached the listeners: one `PING` on that connection, whose
 * reply Redis queues after any push it published before the `PING` ran. A
 * publish made before a command the caller already saw answered is
 * therefore heard by the time this resolves. With no connection open there
 * is nothing in flight. It never rejects: a failed `PING` resolves too, and
 * the caller goes on with what it knew.
 */
export async function flush(client: RedisClient): Promise<void> {
	const state = shared.get(client);
	if (!state) return;
	try {
		await (await state.connection).send('PING', []);
	} catch {}
}
