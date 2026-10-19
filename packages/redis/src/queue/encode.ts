import type { z } from 'zod';
import { QueueError } from '../errors/queue-error';
import { check } from './check';
import { fromJson, toJson } from './round-trip';
import type { QueueDefinition } from './types/queue';

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
	return toJson(definition.schema, data, refused, 'the data ', 'the schema');
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
	const read = fromJson(definition.schema, json);
	return read.ok ? { ok: true, data: read.value as z.output<S> } : read;
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
	if (value === undefined && check(schema, undefined).success) return undefined;
	return toJson(schema, value, refused, '', 'the result schema');
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
	return fromJson(schema, json);
}
