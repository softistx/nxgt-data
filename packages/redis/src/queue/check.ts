import type { z } from 'zod';
import { codesOf } from '../errors/issue-codes';

/** A schema's verdict on a value, with the refusal as zod issue codes only. */
export type Checked =
	| { success: true; data: unknown }
	| { success: false; codes: string };

/**
 * `schema.safeParse(value)`, made to never throw. zod re-raises a throw from
 * a refine or a transform out of `safeParse`; such a throw is a refusal here,
 * `(a check threw)`, and its message, which may quote the value, is dropped.
 * Any other refusal gives its issue codes (`codesOf`), never the issues.
 */
export function check(schema: z.ZodType, value: unknown): Checked {
	try {
		const parsed = schema.safeParse(value);
		return parsed.success
			? { success: true, data: parsed.data }
			: { success: false, codes: codesOf(parsed.error) };
	} catch {
		return { success: false, codes: '(a check threw)' };
	}
}
