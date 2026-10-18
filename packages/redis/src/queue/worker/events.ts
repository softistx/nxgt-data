import type { WorkerContext } from './context';

/** Tells every listener; one that throws must not end the loop. */
export function emit(
	context: Pick<WorkerContext, 'listeners'>,
	error: unknown,
): void {
	for (const listener of context.listeners) {
		try {
			listener(error);
		} catch {
			// A listener that throws must not end the loop.
		}
	}
}

/** Adds a listener; answers the function that removes it. */
export function on(
	context: Pick<WorkerContext, 'listeners'>,
	listener: (error: unknown) => void,
): () => void {
	context.listeners.add(listener);
	return () => void context.listeners.delete(listener);
}
