import { RedisClient, type RedisOptions } from 'bun';
import { RedisError } from '../errors/redis-error';

/** What `ping` found. It never throws: a health check reports, it does not fail. */
export type PingResult =
	| { readonly ok: true; readonly latencyMs: number }
	| { readonly ok: false; readonly error: unknown };

/**
 * One holder of the shared client. Closing it lets the client go once no
 * other holder is left; the client itself is not this object's to close.
 */
export interface RedisConnection extends AsyncDisposable {
	readonly client: RedisClient;
	/** Sends `PING`, and answers within `timeoutMs` (default 2 s) either way. */
	ping(options?: { timeoutMs?: number }): Promise<PingResult>;
	/** Idempotent. The client closes when the last connection to it does. */
	close(): Promise<void>;
}

/** A client shared by every `connectRedis` for one URI. Data only. */
interface Shared {
	readonly options: RedisOptions;
	readonly client: RedisClient;
	readonly connecting: Promise<void>;
	holders: number;
}

const clients = new Map<string, Shared>();

function isPlain(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Options kept as they were given, whatever the caller does to its object
 * afterwards. Without this the stored baseline *is* the caller's object, so
 * an application that keeps one config around and tweaks a field has every
 * later call refused by a comparison against the tweak itself.
 *
 * `structuredClone` will not do: it throws on a function, and an option may
 * hold one. Plain objects and arrays are copied; anything else is kept.
 */
function snapshot<T>(value: T): T {
	if (Array.isArray(value)) return value.map(snapshot) as T;
	if (!isPlain(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, v]) => [key, snapshot(v)]),
	) as T;
}

function share(uri: string, options: RedisOptions): Shared {
	const found = clients.get(uri);
	if (found) {
		// Compared by value, because an options object is usually built again
		// at each call and identity would refuse every second one. Bun's own
		// `deepEquals` does it, so this package writes no comparer: a function
		// inside the options is compared by reference, which is what is wanted.
		if (!Bun.deepEquals(found.options, options)) {
			// The URI is not in the message: it may carry a password.
			throw new TypeError(
				'connectRedis: this URI is already connected with other options. ' +
					'Pass the same options everywhere, or close the first connection.',
			);
		}
		return found;
	}
	const client = new RedisClient(uri, options);
	const shared: Shared = {
		options: snapshot(options),
		client,
		connecting: client.connect(),
		holders: 0,
	};
	clients.set(uri, shared);
	// A failed connect is forgotten, so that the next call tries again.
	shared.connecting.catch(() => {
		if (clients.get(uri) === shared) clients.delete(uri);
	});
	return shared;
}

async function ping(
	client: RedisClient,
	timeoutMs = 2_000,
): Promise<PingResult> {
	const started = performance.now();
	try {
		const answer = client.send('PING', []);
		const timer = new Promise<never>((_, reject) => {
			setTimeout(
				() =>
					reject(
						new RedisError(
							'PING_TIMEOUT',
							'',
							`ping: no answer in ${timeoutMs}ms`,
						),
					),
				timeoutMs,
			).unref?.();
		});
		await Promise.race([answer, timer]);
		return { ok: true, latencyMs: performance.now() - started };
	} catch (error) {
		return { ok: false, error };
	}
}

/**
 * A connection to Redis, over one client shared per URI.
 *
 * ```ts
 * const redis = await connectRedis('redis://cache.internal:6379');
 * await redis.client.set('greeting', 'hello');
 * await redis.close();          // or `await using redis = …`
 * ```
 *
 * Every call with the same URI shares one `RedisClient`, connected once even
 * when the calls race; each gets its own connection to close, and the client
 * closes with the last one. The options must be the same at each call. A
 * connect that fails is forgotten, so calling again retries it.
 *
 * Nothing listens to the process's signals: closing on shutdown is the
 * caller's, with `close()` or `closeRedis()`.
 */
export async function connectRedis(
	uri: string,
	options: RedisOptions = {},
): Promise<RedisConnection> {
	const shared = share(uri, options);
	shared.holders += 1;
	await shared.connecting;
	if (clients.get(uri) !== shared) {
		// `closeRedis` ran while this was connecting: the client is closed.
		throw new RedisError(
			'CONNECTION',
			'',
			'connectRedis: every client was closed while this one was connecting.',
		);
	}
	const { client } = shared;
	let closing: Promise<void> | undefined;
	// Kept, so that a second `close()` waits for the first one's work.
	const close = () => {
		closing ??= (async () => {
			shared.holders -= 1;
			// A client `closeRedis` replaced is not this connection's to drop.
			if (shared.holders > 0 || clients.get(uri) !== shared) return;
			clients.delete(uri);
			client.close();
		})();
		return closing;
	};
	return {
		client,
		ping: (pingOptions) => ping(client, pingOptions?.timeoutMs),
		close,
		[Symbol.asyncDispose]: close,
	};
}

/**
 * Closes every client `connectRedis` opened, whoever still holds one: the
 * end of a process, or of a test file. Their connections' `close()` then does
 * nothing.
 */
export async function closeRedis(): Promise<void> {
	const all = [...clients.values()];
	clients.clear();
	for (const shared of all) {
		await shared.connecting.catch(() => undefined);
		shared.client.close();
	}
}
