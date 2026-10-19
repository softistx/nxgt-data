import type { z } from 'zod';
import type { QueueError } from '../errors/queue-error';
import { check } from './definition/check';

/**
 * The JSON a value is stored as, proved to survive the round trip. With a
 * schema the text is its **output**, parsed back through it; without one the
 * value must come back strictly equal, so a `Date`, a `Map`, a `NaN` or an
 * `{ a: undefined }` is refused. A schema that accepts what it stored (a key
 * set to `undefined`, say) stores it.
 *
 * An output of `undefined` has no JSON form: a caller that stores "no value"
 * handles it before.
 *
 * @param refused - builds the error from the detail.
 * @param subject - what precedes a verb in the detail (`'the data '`, or `''`).
 * @param schemaName - how the detail names the schema (`'the schema'`).
 */
export function toJson(
	schema: z.ZodType | undefined,
	value: unknown,
	refused: (detail: string) => QueueError,
	subject: string,
	schemaName: string,
): string {
	let output = value;
	if (schema !== undefined) {
		const parsed = check(schema, value);
		if (!parsed.success) {
			throw refused(`${subject}does not match ${schemaName} ${parsed.codes}`);
		}
		output = parsed.data;
	}
	let json: string | undefined;
	try {
		json = JSON.stringify(output);
	} catch {
		json = undefined;
	}
	if (json === undefined) throw refused(`${subject}has no JSON form`);
	const back: unknown = JSON.parse(json);
	if (schema === undefined) {
		if (!Bun.deepEquals(back, output, true)) {
			throw refused(`${subject}has no JSON form`);
		}
		return json;
	}
	const again = check(schema, back);
	if (!again.success) {
		throw refused(
			`${subject}does not match ${schemaName} once stored as JSON ${again.codes}`,
		);
	}
	return json;
}

/**
 * Reads stored JSON back, through the schema when there is one. `undefined`
 * json is `undefined`, run through the schema. Text that is not JSON, a value
 * the schema refuses, or a schema that throws is `{ ok: false }`, never thrown.
 */
export function fromJson(
	schema: z.ZodType | undefined,
	json: string | undefined,
): { ok: true; value: unknown } | { ok: false } {
	let raw: unknown;
	try {
		raw = json === undefined ? undefined : JSON.parse(json);
	} catch {
		return { ok: false };
	}
	if (schema === undefined) return { ok: true, value: raw };
	const parsed = check(schema, raw);
	return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}
