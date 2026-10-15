import { S3Error } from '../../errors/s3-error';
import { type BucketContext, callOf } from '../context';
import { shapeOf } from '../shape';
import type { CallOptions } from '../types';

/**
 * Refuses a `timeoutMs` that is not a whole number of milliseconds, 1 or
 * more. Reports the value by its shape, never quoted. Before anything is sent.
 */
export function checkTimeout(
	key: string,
	value: unknown,
	where: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		throw new S3Error(
			'WRONG_OPTION',
			key,
			`timeoutMs is a whole number of milliseconds, 1 or more; got ` +
				`${shapeOf(value)} (${where})`,
		);
	}
	return value;
}

/**
 * The deadline that applies to a call: its own `timeoutMs` first, then the
 * bucket's, else `undefined` — and the call goes the way it always did.
 */
export function deadlineOf<P>(
	context: BucketContext<P>,
	key: string,
	call: string,
	options: CallOptions | undefined,
): number | undefined {
	const own = checkTimeout(key, options?.timeoutMs, callOf(context, call));
	return own ?? context.timeoutMs;
}

/**
 * Runs `run` with a signal that aborts after `timeoutMs`, and turns that
 * abort into `S3Error` `TIMEOUT`. The timer is cleared whichever way it
 * ends, so none outlives the call.
 */
export async function withDeadline<P, T>(
	context: BucketContext<P>,
	key: string,
	call: string,
	timeoutMs: number,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await run(controller.signal);
	} catch (reason) {
		if (!controller.signal.aborted) throw reason;
		throw new S3Error(
			'TIMEOUT',
			key,
			`${callOf(context, call)}: no answer in ${timeoutMs}ms`,
		);
	} finally {
		clearTimeout(timer);
	}
}
