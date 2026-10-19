import type { z } from 'zod';

/**
 * The issue codes of a refusal, each once — `(invalid_type, too_small)`.
 *
 * **Codes only, not zod's messages and not the paths.** Measured on zod
 * 4.6.5: most messages quote the schema (`expected "x"`), but
 * `unrecognized_keys` quotes the stray key the value held
 * (`Unrecognized key: "…"`), a `z.record`'s keys go into the issue's
 * `path`, and a refinement's message is whatever its author wrote. All three
 * come from the value, and a message reports a shape, never a value.
 *
 * Shared by the idempotency results and the queue's payloads, which both
 * refuse a value that came from a request.
 */
export function codesOf(error: z.ZodError): string {
	const codes = [...new Set(error.issues.map((issue) => issue.code))];
	return `(${codes.join(', ')})`;
}
