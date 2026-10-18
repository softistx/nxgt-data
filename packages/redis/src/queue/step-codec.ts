import type { z } from 'zod';
import { QueueError } from '../errors/queue-error';
import { check } from './check';

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
 * `Date`, a `Map` or a `NaN` is refused now rather than read back as
 * something else.
 *
 * A refusal is `QueueError` `INVALID` naming the queue and the step, with the
 * zod issue codes when a schema refused it, never the value. A schema that
 * throws is a refusal too.
 */
export function encodeStep(
	queue: string,
	name: string,
	value: unknown,
	schema?: z.ZodType,
): string {
	const refused = (detail: string) =>
		new QueueError(
			'INVALID',
			queue,
			`step on "${queue}": step "${name}" returned a value that ${detail}`,
		);
	let output = value;
	if (schema !== undefined) {
		const parsed = check(schema, value);
		if (!parsed.success) {
			throw refused(`does not match the schema ${parsed.codes}`);
		}
		output = parsed.data;
	}
	if (output === undefined) return '';
	let json: string | undefined;
	try {
		json = JSON.stringify(output);
	} catch {
		json = undefined;
	}
	if (json === undefined) throw refused('has no JSON form');
	const back: unknown = JSON.parse(json);
	if (schema === undefined) {
		if (!Bun.deepEquals(back, output, true)) {
			throw refused('has no JSON form');
		}
	} else {
		const again = check(schema, back);
		if (!again.success) {
			throw refused(
				`does not match the schema once stored as JSON ${again.codes}`,
			);
		}
	}
	return json;
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
	let raw: unknown;
	try {
		raw = json === '' ? undefined : JSON.parse(json);
	} catch {
		return { ok: false };
	}
	if (schema === undefined) return { ok: true, value: raw };
	const parsed = check(schema, raw);
	return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}
