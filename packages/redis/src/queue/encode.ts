import type { z } from 'zod';
import { codesOf } from '../errors/issue-codes';
import { QueueError } from '../errors/queue-error';
import { durationMs } from './duration';
import type { AddOptions, QueueDefinition } from './types';

/**
 * The JSON a payload is stored as: the schema's **output** (defaults applied),
 * proved to survive the round trip. The stored text is parsed back through the
 * schema, so a value JSON cannot carry — a `Date`, a `Map`, a `bigint`, an
 * `undefined` — is refused now, not when a worker claims the job.
 *
 * The refusal names the queue and the call, and the zod issue **codes**
 * (`codesOf`), never the data and never the issues themselves: a payload came
 * from a request, and zod's messages and paths quote its stray keys and its
 * `z.record` keys. Nothing is attached as a `cause` for the same reason.
 */
export function encodeData<S extends z.ZodType>(
	definition: QueueDefinition<S>,
	data: unknown,
	call: string,
): string {
	const refused = (detail: string) =>
		new QueueError(
			'INVALID',
			definition.name,
			`${call} on "${definition.name}": ${detail}`,
		);
	const parsed = definition.schema.safeParse(data);
	if (!parsed.success) {
		throw refused(
			`the data does not match the schema ${codesOf(parsed.error)}`,
		);
	}
	let json: string | undefined;
	try {
		json = JSON.stringify(parsed.data);
	} catch {
		json = undefined;
	}
	if (json === undefined) throw refused('the data has no JSON form');
	const back = definition.schema.safeParse(JSON.parse(json));
	if (!back.success) {
		throw refused(
			`the data does not match the schema once stored as JSON ${codesOf(back.error)}`,
		);
	}
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
 * `TypeError` naming the call, the queue and the option, as `defineQueue`'s
 * refusals are: it is the caller's code that is wrong, not a request's data.
 * No message prints the value: nothing stops a caller from passing one a
 * request chose.
 */
export function resolveAdd(
	options: AddOptions | undefined,
	call: string,
	queue: string,
): ResolvedAdd {
	const { id, priority, delay, at } = (options ?? {}) as {
		id?: unknown;
		priority?: unknown;
		delay?: unknown;
		at?: unknown;
	};
	const refuse = (what: string): never => {
		throw new TypeError(`${call} on "${queue}": ${what}`);
	};
	if (
		id !== undefined &&
		(typeof id !== 'string' ||
			id.length === 0 ||
			id.length > MAX_ID ||
			id.includes('{') ||
			id.includes('}'))
	) {
		refuse(
			`id is a string of 1 to ${MAX_ID} characters without braces, which are a hash tag`,
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
	return {
		id: (id as string | undefined) ?? Bun.randomUUIDv7(),
		priority: (priority as number | undefined) ?? 0,
		delayMs,
		atMs: at instanceof Date ? Math.max(0, at.getTime()) : -1,
	};
}
