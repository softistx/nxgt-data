import type { z } from 'zod';
import { type Duration, toMs } from './duration';
import type { QueueDefinition, QueueInput } from './types';

const DEFAULTS = {
	attempts: 3,
	backoffBase: 1_000,
	backoffMax: 3_600_000,
	lease: 30_000,
	keepCompletedAge: 3_600_000,
	keepCompletedCount: 1000,
	keepFailed: 604_800_000,
};

/**
 * The lease is renewed every third of itself, and a timer needs at least a
 * few milliseconds to do that; below this the renewal could not keep up.
 */
const MIN_LEASE = 30;

function ms(
	value: Duration | undefined,
	fallback: number,
	call: string,
	name: string,
	what: string,
): number {
	return value === undefined
		? fallback
		: toMs(value, `${call}: "${name}" ${what}`);
}

/**
 * The checks `defineQueue` makes, named after the call that made them —
 * `bindQueue` makes them too, for a definition written by hand. It returns
 * nothing; `defineQueue` resolves the values itself.
 */
export function checkQueue<
	S extends z.ZodType,
	R extends z.ZodType | undefined = undefined,
>(input: QueueInput<S, R> | QueueDefinition<S, R>, call: string): void {
	resolve(input, call);
}

/**
 * Describes a queue. It talks to nothing: `bindQueue` is what needs a client.
 *
 * ```ts
 * export const mails = defineQueue({
 * 	name: 'mails',
 * 	schema: z.object({ to: z.string() }),
 * 	attempts: 5,
 * 	lease: '1m',                   // how long a crashed worker holds a job
 * 	backoff: { base: '2s' },       // the wait before a retry doubles from here
 * });
 * ```
 *
 * A definition that could never work is a bare `TypeError`, thrown here —
 * normally at import. Its values are the code's, not a request's, so the
 * message quotes them.
 */
export function defineQueue<
	S extends z.ZodType,
	R extends z.ZodType | undefined = undefined,
>(input: QueueInput<S, R>): QueueDefinition<S, R> {
	return resolve(input, 'defineQueue');
}

function resolve<S extends z.ZodType, R extends z.ZodType | undefined>(
	input: QueueInput<S, R> | QueueDefinition<S, R>,
	call: string,
): QueueDefinition<S, R> {
	const { name } = input;
	if (typeof name !== 'string' || name.length === 0) {
		throw new TypeError(`${call}: a queue needs a name, for its keys`);
	}
	if (name.includes('{') || name.includes('}')) {
		throw new TypeError(
			`${call}: "${name}" has braces; the name is the keys' hash tag, so it cannot hold any`,
		);
	}
	if (name.includes(':')) {
		throw new TypeError(
			`${call}: "${name}" has a colon; job.key joins the queue name, job id and step name with colons, so the name cannot hold one`,
		);
	}
	if (typeof input.schema?.safeParse !== 'function') {
		throw new TypeError(
			`${call}: "${name}" has no schema; a payload is checked against one both ways`,
		);
	}
	checkResult(input.result, call, name);
	const attempts = input.attempts ?? DEFAULTS.attempts;
	if (!Number.isSafeInteger(attempts) || attempts < 1) {
		throw new TypeError(
			`${call}: "${name}" has attempts of ${attempts}; it is a whole number of runs, and must be at least 1`,
		);
	}
	const base = ms(
		input.backoff?.base,
		DEFAULTS.backoffBase,
		call,
		name,
		'backoff base',
	);
	const max = ms(
		input.backoff?.max,
		DEFAULTS.backoffMax,
		call,
		name,
		'backoff max',
	);
	if (base > max) {
		throw new TypeError(
			`${call}: "${name}" has a backoff base of ${base}ms above its max of ${max}ms`,
		);
	}
	const lease = ms(input.lease, DEFAULTS.lease, call, name, 'lease');
	if (lease < MIN_LEASE) {
		throw new TypeError(
			`${call}: "${name}" has a lease of ${lease}ms; it is renewed every third of itself, so it must be at least ${MIN_LEASE}ms`,
		);
	}
	const keepFailed = ms(
		input.keepFailed,
		DEFAULTS.keepFailed,
		call,
		name,
		'keepFailed',
	);
	const timeout = timeoutOf(input.timeout, call, name);
	return Object.freeze({
		name,
		schema: input.schema,
		result: input.result as R,
		attempts,
		backoff: Object.freeze({ base, max }),
		lease,
		keepCompleted: keepCompleted(input.keepCompleted, call, name),
		keepFailed,
		timeout,
	});
}

function checkResult(
	result: z.ZodType | undefined,
	call: string,
	name: string,
): void {
	if (result !== undefined && typeof result.safeParse !== 'function') {
		throw new TypeError(
			`${call}: "${name}" has a result that is not a schema; a result is checked against one both ways`,
		);
	}
}

function timeoutOf(
	value: Duration | undefined,
	call: string,
	name: string,
): number | undefined {
	if (value === undefined) return undefined;
	const timeout = toMs(value, `${call}: "${name}" timeout`);
	if (timeout < 1) {
		throw new TypeError(
			`${call}: "${name}" has a timeout of ${timeout}ms; it must be at least 1ms, or left out for no limit`,
		);
	}
	return timeout;
}

function keepCompleted(
	value: QueueInput<z.ZodType>['keepCompleted'],
	call: string,
	name: string,
): QueueDefinition<z.ZodType>['keepCompleted'] {
	if (value === false) {
		return false;
	}
	const count = value?.count ?? DEFAULTS.keepCompletedCount;
	if (!Number.isSafeInteger(count) || count < 0) {
		throw new TypeError(
			`${call}: "${name}" has a keepCompleted count of ${count}; it is a whole number of jobs, from 0`,
		);
	}
	return Object.freeze({
		age: ms(
			value?.age,
			DEFAULTS.keepCompletedAge,
			call,
			name,
			'keepCompleted age',
		),
		count,
	});
}
