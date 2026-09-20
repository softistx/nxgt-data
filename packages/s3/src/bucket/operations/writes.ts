import { type BucketContext, keyOf } from '../context';
import { checkOption, checkSize, checkType, effectiveType } from '../guards';
import type { PutBody, PutOptions } from '../types';

/**
 * Writes it, once the bucket's content type and size have accepted it. Both
 * guards run before `write` is called, so a refused body is never sent.
 */
export async function putObject<P>(
	context: BucketContext<P>,
	params: P,
	body: PutBody,
	options: PutOptions = {},
): Promise<void> {
	const key = keyOf(context, params);
	const type = effectiveType(body, options.type);
	checkType(context, key, type);
	checkSize(context, key, body);
	// Refused here with the other two, so every guard on this call answers
	// before anything is sent, and every one of them is an `S3Error`.
	const forwarded = passed(key, options);
	// The very type `checkType` approved, and nothing else: `type` is not one
	// of the keys `passed` forwards, so no option can carry a second one in
	// beside it.
	await context.client.write(key, body, {
		...forwarded,
		...(type ? { type } : {}),
	});
}

/**
 * The options this package forwards, and only those.
 *
 * `PutOptions` refuses the rest at compile time, and that is not enough:
 * measured, spreading the caller's object straight through let a `bucket`
 * key **redirect the write to another bucket** — the object was stored
 * somewhere the definition never described, and the call reported success.
 * Options that arrive from outside a handler are not typed, so the list is
 * applied at run time as well. A key that is not here is dropped, never sent.
 */
type Forwardable = Exclude<keyof PutOptions, 'type'>;

const PASSED = [
	'acl',
	'storageClass',
	'contentDisposition',
	'contentEncoding',
] as const satisfies readonly Forwardable[];

/**
 * `satisfies` proves every key listed is real; it proves nothing about one
 * that is **missing**. Widen `PutOptions` and forget to list the new key
 * here, and the type would advertise an option the run time silently drops —
 * which is the failure this allowlist exists to prevent, in the other
 * direction. This line is what fails the build instead.
 */
type Unforwarded = Exclude<Forwardable, (typeof PASSED)[number]>;
const _nothingForgotten: [Unforwarded] extends [never] ? true : Unforwarded =
	true;
void _nothingForgotten;

function passed(key: string, options: PutOptions): PutOptions {
	const forwarded: Record<string, unknown> = {};
	for (const name of PASSED) {
		const value = options[name];
		if (value === undefined) continue;
		checkOption(key, name, value);
		forwarded[name] = value;
	}
	return forwarded as PutOptions;
}

/** Removes it. S3 does not say whether anything was there, and nor does this. */
export function deleteObject<P>(
	context: BucketContext<P>,
	params: P,
): Promise<void> {
	return context.client.delete(keyOf(context, params));
}
