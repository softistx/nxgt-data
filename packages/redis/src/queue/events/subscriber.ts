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
		await state.leaving.get(channel);
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

/** Drops a channel nobody listens to; closes the connection when none is left. */
async function leave(
	client: RedisClient,
	state: Shared,
	channel: string,
	entry: Entry,
): Promise<void> {
	state.channels.delete(channel);
	if (state.channels.size === 0 && shared.get(client) === state) {
		// Out of the map first, so a listen arriving from now on opens its own.
		shared.delete(client);
		await entry.ready.catch(() => undefined);
		(await state.connection).close();
		return;
	}
	const leaving = (async () => {
		await entry.ready.catch(() => undefined);
		await (await state.connection).unsubscribe(channel);
	})();
	state.leaving.set(channel, leaving);
	try {
		await leaving;
	} finally {
		if (state.leaving.get(channel) === leaving) state.leaving.delete(channel);
	}
}

/**
 * Hears a channel through the client's one shared subscriber connection.
 *
 * The first listen on a client opens a single duplicate, whatever the number
 * of queues bound to it; each channel is subscribed once however many
 * listeners it has. Resolves once Redis confirmed the SUBSCRIBE, so a publish
 * right after the `await` is heard. A listener that throws reaches neither
 * the others nor the connection.
 *
 * Resolves with the function that removes this listener: it unsubscribes a
 * channel left with none, closes the connection when the client has no
 * listener left, and is a no-op the second time.
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
