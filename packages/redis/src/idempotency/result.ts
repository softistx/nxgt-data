import type { z } from 'zod';
import { GuardError } from '../errors/guard-error';
import { codesOf } from '../errors/issue-codes';

const invalid = (name: string, detail: string) =>
	new GuardError('INVALID', name, `run on "${name}": ${detail}`);

/**
 * Parses what `work` returned, stores it as JSON, and parses that JSON back:
 * the value `run` hands the first caller is the one every replay will hand
 * back, and a result that could not be replayed — a `z.date()`, which JSON
 * turns into a string; a transform that does not accept its own output — is
 * refused now, while the key can still be released, rather than on every
 * replay for the whole `ttl`.
 */
export async function toStored<T>(
	name: string,
	schema: z.ZodType,
	result: unknown,
): Promise<{ json: string; value: T }> {
	const parsed = await schema.safeParseAsync(result);
	if (!parsed.success) {
		throw invalid(
			name,
			`the result does not match the schema, so it was not stored ${codesOf(parsed.error)}`,
		);
	}
	let json: string | undefined;
	try {
		json = JSON.stringify(parsed.data);
	} catch {
		json = undefined;
	}
	if (json === undefined) {
		throw invalid(name, 'the result has no JSON form, so it was not stored');
	}
	const again = await schema.safeParseAsync(JSON.parse(json));
	if (!again.success) {
		throw invalid(
			name,
			'the result does not match the schema once stored as JSON, so it was not stored ' +
				codesOf(again.error),
		);
	}
	return { json, value: again.data as T };
}

/**
 * Parses a stored result. A failure is `INVALID`, **not a miss**: running
 * `work` again would repeat the side effect the stored result stands for.
 */
export async function fromStored<T>(
	name: string,
	schema: z.ZodType,
	json: string,
): Promise<T> {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		throw corrupt(name);
	}
	const parsed = await schema.safeParseAsync(raw);
	if (!parsed.success) {
		throw invalid(
			name,
			'the stored result no longer matches the schema, and the work was not run again ' +
				codesOf(parsed.error),
		);
	}
	return parsed.data as T;
}

/** A record at the key that `run` could not have written. */
export function corrupt(name: string): GuardError {
	return invalid(
		name,
		'the stored record is not one this package wrote, and the work was not run again',
	);
}
