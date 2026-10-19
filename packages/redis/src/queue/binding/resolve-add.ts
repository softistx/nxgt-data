import { type ResolvedDedupe, resolveDedupe } from '../definition/dedupe';
import { resolveGroup } from '../definition/group';
import { durationMs } from '../duration';
import { isName, NAME_RULE } from '../name';
import { clampTimeout } from '../timers';
import type { AddOptions } from '../types/queue';

/** What a script is given for one job's options, all in the units it reads. */
export type ResolvedAdd = {
	id: string;
	priority: number;
	delayMs: number;
	/** `-1` when the job has no `at`. */
	atMs: number;
	/** The job's own `timeout`, in ms, capped at the longest timer; `undefined` stores none (the worker applies the queue's at run time). */
	timeoutMs: number | undefined;
	/** The `debounce` or `throttle` as the script reads it; a debounce's `delayMs` is its wait. */
	dedupe: ResolvedDedupe;
	/** `''` for the default group. */
	group: string;
};

/**
 * Checks `add`'s options and resolves them. A malformed one is a bare
 * `TypeError` naming the call, the queue and the option, as `defineQueue`'s
 * refusals are: it is the caller's code that is wrong, not a request's data.
 * No message prints the value: nothing stops a caller from passing one a
 * request chose.
 */
export function resolveAdd(
	options: AddOptions | undefined,
	call: string,
	queue: string,
	grouped: boolean,
): ResolvedAdd {
	const { id, priority, delay, at, timeout } = (options ?? {}) as {
		id?: unknown;
		priority?: unknown;
		delay?: unknown;
		at?: unknown;
		timeout?: unknown;
	};
	const refuse = (what: string): never => {
		throw new TypeError(`${call} on "${queue}": ${what}`);
	};
	if (id !== undefined && !isName(id)) {
		refuse(`id is ${NAME_RULE}`);
	}
	if (typeof id === 'string' && id.startsWith('schedule:')) {
		refuse(
			'id cannot start with "schedule:", which names scheduled occurrences',
		);
	}
	if (
		priority !== undefined &&
		(typeof priority !== 'number' ||
			!Number.isInteger(priority) ||
			priority < 0 ||
			priority > 1000)
	) {
		refuse('priority is a whole number from 0 to 1000');
	}
	if (delay !== undefined && at !== undefined) {
		refuse('delay and at say the same thing; give one');
	}
	if (
		at !== undefined &&
		(!(at instanceof Date) || Number.isNaN(at.getTime()))
	) {
		refuse('at is a valid Date');
	}
	let delayMs = 0;
	if (delay !== undefined) {
		const ms = durationMs(delay);
		if (ms === undefined) {
			refuse(
				"delay is a whole number of milliseconds or a string such as '10m'",
			);
		} else {
			delayMs = ms;
		}
	}
	let timeoutMs: number | undefined;
	if (timeout !== undefined) {
		timeoutMs = durationMs(timeout);
		if (timeoutMs === undefined || timeoutMs < 1) {
			refuse(
				"timeout is at least 1 millisecond, as a whole number or a string such as '10m'",
			);
		}
	}
	const dedupe = resolveDedupe(options, call, queue);
	const group = resolveGroup(options?.group, grouped, call, queue);
	return {
		group,
		id: (id as string | undefined) ?? Bun.randomUUIDv7(),
		priority: (priority as number | undefined) ?? 0,
		dedupe,
		delayMs: dedupe.mode === 'd' ? dedupe.waitMs : delayMs,
		atMs: at instanceof Date ? Math.max(0, at.getTime()) : -1,
		// Stored as a timer can wait it, so the hash never holds more digits
		// than the claim trusts; the worker would cap it the same way.
		timeoutMs: clampTimeout(timeoutMs),
	};
}
