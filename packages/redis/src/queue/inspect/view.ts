import type { z } from 'zod';
import { decodeData, decodeResult } from '../binding/encode';
import type { ResultOf } from '../types/result-types';
import type { JobState, JobView, QueueDefinition } from '../types/types';

/** The states a stored job may be in. */
export const STATES: readonly string[] = [
	'waiting',
	'delayed',
	'active',
	'completed',
	'failed',
];

function date(value: string | undefined): Date | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	return new Date(Number(value));
}

/**
 * The `{name, message}` a job's stored `error` holds, or `undefined` for an
 * absent one, or text that is not an object with a string `name` and `message`.
 */
export function parseStoredError(
	stored: string | null | undefined,
): { name: string; message: string } | undefined {
	if (stored === undefined || stored === null) return undefined;
	try {
		const error = JSON.parse(stored) as unknown;
		if (error === null || typeof error !== 'object') return undefined;
		const { name, message } = error as { name?: unknown; message?: unknown };
		if (typeof name !== 'string' || typeof message !== 'string') {
			return undefined;
		}
		return { name, message };
	} catch {
		return undefined;
	}
}

/**
 * Maps a job hash to a {@link JobView}. A hash that is not one this package
 * wrote (no `state` it knows) is `undefined`, as an absent job is: showing
 * guessed fields would be the "repair" the scripts refuse to do.
 */
export function toView<
	S extends z.ZodType,
	R extends z.ZodType | undefined = undefined,
>(
	definition: QueueDefinition<S, R>,
	id: string,
	hash: Record<string, string> | null,
): JobView<S, R> | undefined {
	if (!hash) return undefined;
	const { state, data, attempt, attempts, priority } = hash;
	const { error: stored, finished: end, result } = hash;
	const added = date(hash['added']);
	const runAt = date(hash['runAt']);
	if (
		state === undefined ||
		!STATES.includes(state) ||
		added === undefined ||
		runAt === undefined
	) {
		return undefined;
	}
	const decoded = data === undefined ? undefined : decodeData(definition, data);
	const view: JobView<S, R> = {
		id,
		state: state as JobState,
		data: decoded?.ok ? decoded.data : undefined,
		attempt: Number(attempt),
		attempts: Number(attempts),
		priority: Number(priority),
		progress: Number(hash['progress'] ?? 0),
		added,
		runAt,
	};
	const error = parseStoredError(stored);
	if (error) view.error = error;
	if (result !== undefined) {
		const read = decodeResult(definition, result);
		if (read.ok) view.result = read.value as ResultOf<R>;
	}
	if (hash['group']) view.group = hash['group'];
	const finished = date(end);
	if (finished) view.finished = finished;
	return view;
}
