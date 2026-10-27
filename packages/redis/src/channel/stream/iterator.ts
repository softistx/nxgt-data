import {
	DEFAULT_BUFFER_SIZE,
	type Listener,
	type StreamContext,
	type StreamOptions,
} from './context';
import { add, remove } from './listeners';
import { open } from './subscription';

const finished = { value: undefined, done: true } as const;

export type StreamIterator<T> = AsyncGenerator<T, undefined, undefined> &
	AsyncDisposable;

function checkBufferSize(bufferSize: number | undefined): number {
	if (bufferSize === undefined) return DEFAULT_BUFFER_SIZE;
	if (!Number.isInteger(bufferSize) || bufferSize < 1) {
		throw new TypeError(
			`stream: bufferSize is ${bufferSize}; it is a number of messages, a whole number of at least 1`,
		);
	}
	return bufferSize;
}

/**
 * One iterator. Hand-written, not an `async *` generator: a generator's
 * `return()` queues behind a pending `next()`, so a client that left while the
 * stream was idle would keep its listener until the next message. It
 * registers on its first read, so one that is returned before then holds
 * nothing. The first read starts the subscribe but does not wait for it.
 */
export function createIterator<T>(
	ctx: StreamContext<T>,
	key: string,
	options: StreamOptions,
): StreamIterator<T> {
	const limit = checkBufferSize(options.bufferSize);
	const queue: T[] = [];
	const waiters: (() => void)[] = [];
	const wake = () => {
		for (const resolve of waiters.splice(0)) resolve();
	};
	let stopped = ctx.closed;
	let started = false;
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
	const leave = () => {
		stopped = true;
		remove(ctx, listener);
		wake();
	};
	const iterator: StreamIterator<T> = {
		async next() {
			// Closed since the iterator was made: nothing will wake it.
			if (ctx.closed) stopped = true;
			if (!stopped && !started) {
				started = true;
				add(ctx, listener);
				// In the background: a read never waits for the subscribe, which
				// takes as long as the connection attempt to fail, while a message
				// delivered locally is already in the queue. `open` forgets its
				// own failure.
				void open(ctx);
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
}
