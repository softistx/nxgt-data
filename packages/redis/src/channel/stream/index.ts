import type { StreamContext, StreamOptions, StreamSource } from './context';
import { newContext } from './context';
import { createIterator, type StreamIterator } from './iterator';
import { deliver, stopAll } from './listeners';
import { release } from './subscription';

export type { StreamOptions, StreamSource } from './context';

/** What `createKeyedStreams` gives back. */
export interface KeyedStreams<T> {
	/** The messages whose key is `key`, until the iterator is returned. */
	stream(key: string, options?: StreamOptions): StreamIterator<T>;
	/**
	 * Publishes through the source. With `fallback`, a transport failure
	 * delivers the parsed message to this process's iterators of its key and
	 * resolves with `0`; a message the schema refuses still throws, and so does a
	 * key nobody here reads, unless `dropUnread` makes it resolve with `0`.
	 */
	publish(message: T): Promise<number>;
	/** How many iterators are open. */
	readonly listeners: number;
	/** Stops every iterator and closes the shared subscription. Idempotent. */
	close(): Promise<void>;
}

async function publishVia<T>(
	ctx: StreamContext<T>,
	message: T,
): Promise<number> {
	try {
		const reached = await ctx.source.publish(message);
		return typeof reached === 'number' ? reached : 0;
	} catch (error) {
		if (!ctx.fallback || ctx.source.refuses?.(error) === true) throw error;
		const parsed = ctx.source.parse ? ctx.source.parse(message) : message;
		if (!ctx.byKey.has(ctx.keyOf(parsed))) {
			if (ctx.dropUnread) return 0;
			throw error;
		}
		deliver(ctx, parsed);
		return 0;
	}
}

/**
 * A keyed, in-memory fan-out over one subscription: opened lazily by the
 * first read, closed when the last iterator leaves, forgotten when its open
 * fails so that the next iterator tries again.
 */
export function createKeyedStreams<T>(
	source: StreamSource<T>,
	keyOf: (message: T) => string,
	options: { fallback?: boolean; dropUnread?: boolean } = {},
): KeyedStreams<T> {
	const ctx = newContext(
		source,
		keyOf,
		options.fallback === true,
		options.dropUnread === true,
	);
	return {
		get listeners() {
			return ctx.count;
		},
		stream: (key, streamOptions = {}) =>
			createIterator(ctx, key, streamOptions),
		publish: (message) => publishVia(ctx, message),
		async close() {
			ctx.closed = true;
			stopAll(ctx);
			await release(ctx);
		},
	};
}
