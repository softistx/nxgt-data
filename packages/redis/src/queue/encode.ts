import type { z } from 'zod';
import { QueueError } from '../errors/queue-error';
import { check } from './check';
import { durationMs } from './duration';
import { clampTimeout } from './timers';
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
 * `z.record` keys. Nothing is attached as a `cause` for the same reason. A
 * schema that throws (a refine or a transform) is a refusal too, `INVALID`,
 * and its message is dropped.
 */
export function encodeData<S extends z.ZodType>(
	definition: QueueDefinition<S, z.ZodType | undefined>,
	data: unknown,
	call: string,
): string {
	const refused = (detail: string) =>
		new QueueError(
			'INVALID',
			definition.name,
			`${call} on "${definition.name}": ${detail}`,
		);
	const parsed = check(definition.schema, data);
	if (!parsed.success) {
		throw refused(`the data does not match the schema ${parsed.codes}`);
	}
	let json: string | undefined;
	try {
		json = JSON.stringify(parsed.data);
	} catch {
		json = undefined;
	}
	if (json === undefined) throw refused('the data has no JSON form');
	const back = check(definition.schema, JSON.parse(json));
	if (!back.success) {
		throw refused(
			`the data does not match the schema once stored as JSON ${back.codes}`,
		);
	}
	return json;
}

/**
 * Reads stored JSON back through the schema. A payload the schema no longer
 * accepts (it changed under a waiting job), or a schema that throws on it, is
 * `{ ok: false }`, never thrown:
 * the caller decides what a job it cannot read becomes.
 */
export function decodeData<S extends z.ZodType>(
	definition: QueueDefinition<S, z.ZodType | undefined>,
	json: string,
): { ok: true; data: z.output<S> } | { ok: false } {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return { ok: false };
	}
	const parsed = check(definition.schema, raw);
	return parsed.success
		? { ok: true, data: parsed.data as z.output<S> }
		: { ok: false };
}

/** What a script is given for one job's options, all in the units it reads. */
export type ResolvedAdd = {
	id: string;
	priority: number;
	delayMs: number;
	/** `-1` when the job has no `at`. */
	atMs: number;
	/** The job's own `timeout`, in ms, capped at the longest timer; `undefined` stores none (the worker applies the queue's at run time). */
	timeoutMs: number | undefined;
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
	let timeoutMs: number | undefined;
	if (timeout !== undefined) {
		timeoutMs = durationMs(timeout);
		if (timeoutMs === undefined || timeoutMs < 1) {
			refuse(
				"timeout is at least 1 millisecond, as a whole number or a string such as '10m'",
			);
		}
	}
	return {
		id: (id as string | undefined) ?? Bun.randomUUIDv7(),
		priority: (priority as number | undefined) ?? 0,
		delayMs,
		atMs: at instanceof Date ? Math.max(0, at.getTime()) : -1,
		// Stored as a timer can wait it, so the hash never holds more digits
		// than the claim trusts; the worker would cap it the same way.
		timeoutMs: clampTimeout(timeoutMs),
	};
}

/**
 * The JSON a handler's return is stored as: the result schema's **output**,
 * proved to survive the round trip, as {@link encodeData} does for a payload.
 * A queue without a `result` schema stores nothing (`undefined`), and so does
 * a handler that returned `undefined` when the schema accepts it (`z.void()`,
 * `.optional()`): no result. A required schema refuses `undefined` as it
 * refuses any value, so the job fails instead of completing empty. The refusal
 * names the queue and the zod issue codes, never the value; a schema that
 * throws is refused the same way.
 *
 * The text is what a worker hands to `complete`.
 */
export function encodeResult(
	definition: QueueDefinition<z.ZodType, z.ZodType | undefined>,
	value: unknown,
	queue: string,
): string | undefined {
	const schema = definition.result;
	if (schema === undefined) return undefined;
	const refused = (detail: string) =>
		new QueueError(
			'INVALID',
			queue,
			`work on "${queue}": the result ${detail}`,
		);
	const parsed = check(schema, value);
	if (parsed.success && value === undefined) return undefined;
	if (!parsed.success) {
		throw refused(`does not match the result schema ${parsed.codes}`);
	}
	let json: string | undefined;
	try {
		json = JSON.stringify(parsed.data);
	} catch {
		json = undefined;
	}
	if (json === undefined) throw refused('has no JSON form');
	const back = check(schema, JSON.parse(json));
	if (!back.success) {
		throw refused(
			`does not match the result schema once stored as JSON ${back.codes}`,
		);
	}
	return json;
}

/**
 * Reads a stored result back through the result schema. A queue without one
 * has no result (`value` is `undefined`); a result the schema refuses is
 * `{ ok: false }`, never thrown, and so is a schema that throws on it (a
 * refine or a transform that throws). `undefined` json runs the schema on
 * `undefined`: `z.void()` or `.optional()` reads back `undefined`, a required
 * schema is `{ ok: false }`, reachable only through a write this package did
 * not make, since `encodeResult` refuses `undefined` for one.
 */
export function decodeResult(
	definition: QueueDefinition<z.ZodType, z.ZodType | undefined>,
	json: string | undefined,
): { ok: true; value: unknown } | { ok: false } {
	const schema = definition.result;
	if (schema === undefined) return { ok: true, value: undefined };
	let raw: unknown;
	try {
		raw = json === undefined ? undefined : JSON.parse(json);
	} catch {
		return { ok: false };
	}
	const parsed = check(schema, raw);
	return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}
