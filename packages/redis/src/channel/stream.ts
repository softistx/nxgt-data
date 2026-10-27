/** Messages a slow reader may leave unread before its oldest are dropped. */
const DEFAULT_BUFFER_SIZE = 256;

/** The part of a channel a keyed stream is built on. */
export interface StreamSource<T> {
	publish(message: T): Promise<unknown>;
	subscribe(
		handler: (message: T) => void,
		options?: { onError?: (error: unknown, raw: string) => void },
	): Promise<{ close(): Promise<void> }>;
}

export interface StreamOptions {
	/**
	 * Messages this iterator may leave unread before the oldest are dropped.
	 * Default 256, at least 1.
	 */
	bufferSize?: number;
}

/** What `createKeyedStreams` gives back. */
export interface KeyedStreams<T> {
	/** The messages whose key is `key`, until the iterator is returned. */
	stream(
		key: string,
		options?: StreamOptions,
	): AsyncGenerator<T, undefined, undefined> & AsyncDisposable;
	/**
	 * Publishes through the source. When that fails while iterators of this
	 * process are open, the message goes to them directly and the call
	 * resolves with `0`; with none open, the failure is thrown.
	 */
	publish(message: T): Promise<number>;
	/** How many iterators are open. */
	readonly listeners: number;
	/** Stops every iterator and closes the shared subscription. Idempotent. */
	close(): Promise<void>;
}

interface Listener<T> {
	key: string;
	push(message: T): void;
	stop(): void;
}

/**
 * A keyed, in-memory fan-out over one subscription.
 *
 * - ONE subscription for the process, opened lazily by the first read and
 *   closed when the last iterator leaves.
 * - A failed subscribe is forgotten, so the next iterator tries again; the
 *   iterator itself is not refused.
 * - The iterator is hand-written, not an `async *` generator: a generator's
 *   `return()` queues behind a pending `next()`, so a client that left while
 *   the stream was idle would keep its listener until the next message.
 */
export function createKeyedStreams<T>(
	source: StreamSource<T>,
	keyOf: (message: T) => string,
): KeyedStreams<T> {
	const byKey = new Map<string, Set<Listener<T>>>();
	let count = 0;
	let closed = false;
	let opened: Promise<{ close(): Promise<void> }> | undefined;

	const deliver = (message: T) => {
		for (const listener of byKey.get(keyOf(message)) ?? []) {
			listener.push(message);
		}
	};

	// Forgets the subscription and closes it, once it has finished opening.
	const release = async () => {
		const pending = opened;
		opened = undefined;
		if (pending === undefined) return;
		try {
			await (await pending).close();
		} catch {
			// It failed to open (nothing to close) or to close (nothing to do).
		}
	};

	const open = async () => {
		if (opened !== undefined || closed) return;
		const attempt = source.subscribe(deliver);
		opened = attempt;
		try {
			await attempt;
		} catch {
			if (opened === attempt) opened = undefined;
		}
	};

	const add = (listener: Listener<T>) => {
		const set = byKey.get(listener.key) ?? new Set<Listener<T>>();
		byKey.set(listener.key, set);
		set.add(listener);
		count += 1;
	};

	const remove = (listener: Listener<T>) => {
		const set = byKey.get(listener.key);
		if (set === undefined || !set.delete(listener)) return;
		count -= 1;
		if (set.size === 0) byKey.delete(listener.key);
		if (count === 0) void release();
	};

	const finished = { value: undefined, done: true } as const;

	return {
		get listeners() {
			return count;
		},

		stream(key, options = {}) {
			const limit = Math.max(1, options.bufferSize ?? DEFAULT_BUFFER_SIZE);
			const queue: T[] = [];
			const waiters: (() => void)[] = [];
			const wake = () => {
				for (const resolve of waiters.splice(0)) resolve();
			};
			let stopped = closed;
			const listener: Listener<T> = {
				key,
				push: (message) => {
					if (queue.length >= limit) queue.shift();
					queue.push(message);
					wake();
				},
				stop: () => {
					stopped = true;
					wake();
				},
			};
			if (!stopped) add(listener);
			const leave = () => {
				stopped = true;
				remove(listener);
				wake();
			};
			let opening: Promise<void> | undefined;
			const iterator: AsyncGenerator<T, undefined, undefined> &
				AsyncDisposable = {
				async next() {
					if (!stopped) {
						// Opens on the first read. A failed open is not retried by
						// this iterator, but by the next one.
						opening ??= open();
						await opening;
					}
					while (!stopped) {
						const next = queue.shift();
						if (next !== undefined) return { value: next, done: false };
						await new Promise<void>((resolve) => waiters.push(resolve));
					}
					leave();
					return finished;
				},
				async return() {
					leave();
					return finished;
				},
				async throw(error: unknown) {
					leave();
					throw error;
				},
				[Symbol.asyncIterator]() {
					return iterator;
				},
				async [Symbol.asyncDispose]() {
					leave();
				},
			};
			return iterator;
		},

		async publish(message) {
			try {
				const reached = await source.publish(message);
				return typeof reached === 'number' ? reached : 0;
			} catch (error) {
				if (count === 0) throw error;
				deliver(message);
				return 0;
			}
		},

		async close() {
			closed = true;
			for (const set of [...byKey.values()]) {
				for (const listener of set) listener.stop();
			}
			byKey.clear();
			count = 0;
			await release();
		},
	};
}
