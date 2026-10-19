import type { z } from 'zod';
import { QueueError } from '../../../errors/queue-error';
import { check } from '../../definition/check';
import { fromJson, toJson } from '../../round-trip';

const MAX_STEP_NAME = 128;

/**
 * Checks a step's name: a string of 1 to 128 characters without `:`, which
 * separates the parts of a job's keys. Anything else is a bare `TypeError`
 * naming the call and the queue, never the name, as `resolveAdd`'s refusals
 * are.
 *
 * @param call - `'step'` or `'key'`, the call the message names.
 * @returns the name, once proved.
 */
export function checkStepName(
	queue: string,
	call: 'step' | 'key',
	name: unknown,
): string {
	if (
		typeof name !== 'string' ||
		name.length === 0 ||
		name.length > MAX_STEP_NAME ||
		name.includes(':')
	) {
		throw new TypeError(
			`${call} on "${queue}": name is a string of 1 to ${MAX_STEP_NAME} characters without ":"`,
		);
	}
	return name;
}

/**
 * The text a step's value is stored as. `undefined` is `''` (no value), when
 * there is no schema or the schema accepts `undefined`. With a schema the
 * stored text is its **output**, parsed back through it as `encodeData` does;
 * without one the value must survive the JSON round trip unchanged, so a
 * `Date`, a `Map`, a `NaN` or `{ a: undefined }` is refused now rather than
 * read back as something else. A schema that accepts `{ a: undefined }`
 * stores it.
 *
 * A refusal is `QueueError` `INVALID` naming the queue, the step and the
 * `job` id when given, with the
 * zod issue codes when a schema refused it, never the value. A schema that
 * throws is a refusal too.
 */
export function encodeStep(
	queue: string,
	name: string,
	value: unknown,
	schema?: z.ZodType,
	job?: string,
): string {
	const refused = (detail: string) =>
		new QueueError(
			'INVALID',
			queue,
			`step on "${queue}": step "${name}" returned a value that ${detail}`,
			job,
		);
	if (value === undefined) {
		if (schema === undefined || check(schema, undefined).success) return '';
	}
	return toJson(schema, value, refused, '', 'the schema');
}

/**
 * Reads a stored step back: `''` is `undefined`, run through the schema when
 * there is one. A value the schema refuses, a schema that throws, or text
 * that is not JSON is `{ ok: false }`, never thrown: the caller decides what a
 * step it cannot read becomes.
 */
export function decodeStep(
	json: string,
	schema?: z.ZodType,
): { ok: true; value: unknown } | { ok: false } {
	return fromJson(schema, json === '' ? undefined : json);
}
