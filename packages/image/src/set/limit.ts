/**
 * A FIFO semaphore: `limit(task)` runs the task once fewer than `max` tasks
 * are running, tasks starting in the order they were submitted. A task that
 * throws frees its place, and its error is the caller's.
 */
export function createLimit(
	max: number,
): <T>(task: () => Promise<T>) => Promise<T> {
	let running = 0;
	const waiting: (() => void)[] = [];

	const release = () => {
		const next = waiting.shift();
		if (next) next();
		else running--;
	};

	return async <T>(task: () => Promise<T>): Promise<T> => {
		if (running < max) running++;
		// The place passes straight to the next waiter, so `running` is exact.
		else await new Promise<void>((resolve) => waiting.push(resolve));
		try {
			return await task();
		} finally {
			release();
		}
	};
}
