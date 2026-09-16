import { type Db, MongoClient, type MongoClientOptions } from 'mongodb';

/** What `ping` found. It never throws: a health check reports, it does not fail. */
export type PingResult =
	| { readonly ok: true; readonly latencyMs: number }
	| { readonly ok: false; readonly error: unknown };

/**
 * One holder of the shared client. Closing it lets the client go once no
 * other holder is left; the client itself is not this object's to close.
 */
export interface MongoConnection extends AsyncDisposable {
	readonly client: MongoClient;
	/** The URI's database, or `test` when the URI names none — the driver's default. */
	readonly db: Db;
	/** Sends `ping`, and answers within `timeoutMS` (default 2 s) either way. */
	ping(options?: { timeoutMS?: number }): Promise<PingResult>;
	/** Idempotent. The client closes when the last connection to it does. */
	close(): Promise<void>;
}

/** A client shared by every `connectMongo` for one URI. Data only. */
interface Shared {
	readonly options: MongoClientOptions;
	readonly connecting: Promise<MongoClient>;
	holders: number;
}

const clients = new Map<string, Shared>();

/**
 * The same options, compared key by key: an options object is usually built
 * again at each call, so identity would refuse every second call.
 */
function sameOptions(a: MongoClientOptions, b: MongoClientOptions): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) {
		const k = key as keyof MongoClientOptions;
		if (!Object.is(a[k], b[k])) return false;
	}
	return true;
}

function share(uri: string, options: MongoClientOptions): Shared {
	const found = clients.get(uri);
	if (found) {
		if (!sameOptions(found.options, options)) {
			// The URI is not in the message: it may carry a password.
			throw new TypeError(
				'connectMongo: this URI is already connected with other options. ' +
					'Pass the same options everywhere, or close the first connection.',
			);
		}
		return found;
	}
	const shared: Shared = {
		options,
		connecting: new MongoClient(uri, options).connect(),
		holders: 0,
	};
	clients.set(uri, shared);
	// A failed connect is forgotten, so that the next call tries again.
	shared.connecting.catch(() => {
		if (clients.get(uri) === shared) clients.delete(uri);
	});
	return shared;
}

async function ping(db: Db, timeoutMS = 2_000): Promise<PingResult> {
	const started = performance.now();
	try {
		await db.command({ ping: 1 }, { timeoutMS });
		return { ok: true, latencyMs: performance.now() - started };
	} catch (error) {
		return { ok: false, error };
	}
}

/**
 * A connection to MongoDB, over one client shared per URI.
 *
 * ```ts
 * const mongo = await connectMongo('mongodb://db.internal:27017/app');
 * const users = getCollection(mongo.db, usersDefinition);
 * // …
 * await mongo.close();          // or `await using mongo = …`
 * ```
 *
 * Every call with the same URI shares one `MongoClient`, connected once even
 * when the calls race; each gets its own connection to close, and the client
 * closes with the last one. The options must be the same at each call. A
 * connect that fails is forgotten, so calling again retries it.
 *
 * Nothing listens to the process's signals: closing on shutdown is the
 * caller's, with `close()` or `closeMongo()`.
 */
export async function connectMongo(
	uri: string,
	options: MongoClientOptions = {},
): Promise<MongoConnection> {
	const shared = share(uri, options);
	shared.holders += 1;
	let client: MongoClient;
	try {
		client = await shared.connecting;
	} catch (error) {
		shared.holders -= 1;
		throw error;
	}
	const db = client.db();
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		shared.holders -= 1;
		if (shared.holders > 0 || clients.get(uri) !== shared) return;
		clients.delete(uri);
		await client.close();
	};
	return {
		client,
		db,
		ping: (pingOptions) => ping(db, pingOptions?.timeoutMS),
		close,
		[Symbol.asyncDispose]: close,
	};
}

/**
 * Closes every client `connectMongo` opened, whoever still holds one: the
 * end of a process, or of a test file. Their connections' `close()` then does
 * nothing.
 */
export async function closeMongo(): Promise<void> {
	const all = [...clients.values()];
	clients.clear();
	await Promise.all(
		all.map(async (shared) => {
			const client = await shared.connecting.catch(() => undefined);
			await client?.close();
		}),
	);
}
