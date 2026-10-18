import type { z } from 'zod';
import { QueueError } from '../errors/queue-error';
import { toMs } from './duration';
import type { AddOptions, QueueDefinition } from './types';

/**
 * The JSON a payload is stored as: the schema's **output** (defaults applied),
 * proved to survive the round trip. The stored text is parsed back through the
 * schema, so a value JSON cannot carry — a `Date`, a `Map`, a `bigint`, an
 * `undefined` — is refused now, not when a worker claims the job.
 *
 * The refusal names the queue and the call, never the data: a payload came
 * from a request. The zod issues are the `cause`, for whoever debugs it.
 */
export function encodeData<S extends z.ZodType>(
	definition: QueueDefinition<S>,
	data: unknown,
	call: string,
): string {
	const refused = (cause?: unknown) => {
		const error = new QueueError(
			'INVALID',
			definition.name,
			`${call} on "${definition.name}": the data does not match the schema`,
		);
		if (cause !== undefined) error.cause = cause;
		return error;
	};
	const parsed = definition.schema.safeParse(data);
	if (!parsed.success) throw refused(parsed.error);
	let json: string | undefined;
	try {
		json = JSON.stringify(parsed.data);
	} catch (error) {
		throw refused(error);
	}
	if (json === undefined) throw refused();
	const back = decodeData(definition, json);
	if (!back.ok) throw refused();
	return json;
}

/**
 * Reads stored JSON back through the schema. A payload the schema no longer
 * accepts (it changed under a waiting job) is `{ ok: false }`, never thrown:
 * the caller decides what a job it cannot read becomes.
 */
export function decodeData<S extends z.ZodType>(
	definition: QueueDefinition<S>,
	json: string,
): { ok: true; data: z.output<S> } | { ok: false } {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return { ok: false };
	}
	const parsed = definition.schema.safeParse(raw);
	return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
}

/** What a script is given for one job's options, all in the units it reads. */
export type ResolvedAdd = {
	id: string;
	priority: number;
	delayMs: number;
	/** `-1` when the job has no `at`. */
	atMs: number;
};

const MAX_ID = 256;

/**
 * Checks `add`'s options and resolves them. A malformed one is a bare
 * `TypeError` naming the option, as `defineQueue`'s refusals are: it is the
 * caller's code that is wrong, not a request's data.
 */
export function resolveAdd(
	options: AddOptions | undefined,
	call: string,
): ResolvedAdd {
	const { id, priority, delay, at } = (options ?? {}) as {
		id?: unknown;
		priority?: unknown;
		delay?: AddOptions['delay'];
		at?: unknown;
	};
	if (id !== undefined) {
		if (
			typeof id !== 'string' ||
			id.length === 0 ||
			id.length > MAX_ID ||
			id.includes('{') ||
			id.includes('}')
		) {
			throw new TypeError(
				`${call}: id must be a string of 1 to ${MAX_ID} characters without braces, which are a hash tag`,
			);
		}
	}
	if (
		priority !== undefined &&
		(typeof priority !== 'number' ||
			!Number.isInteger(priority) ||
			priority < 0 ||
			priority > 1000)
	) {
		throw new TypeError(
			`${call}: priority is ${String(priority)}; it is a whole number from 0 to 1000`,
		);
	}
	if (delay !== undefined && at !== undefined) {
		throw new TypeError(`${call}: delay and at say the same thing; give one`);
	}
	if (
		at !== undefined &&
		(!(at instanceof Date) || Number.isNaN(at.getTime()))
	) {
		throw new TypeError(`${call}: at must be a valid Date`);
	}
	return {
		id: id ?? Bun.randomUUIDv7(),
		priority: priority ?? 0,
		delayMs: delay === undefined ? 0 : toMs(delay, `${call}: delay`),
		atMs: at instanceof Date ? Math.max(0, at.getTime()) : -1,
	};
}
