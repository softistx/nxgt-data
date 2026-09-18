import { type BucketContext, keyOf } from '../context';
import { checkSize, checkType, effectiveType } from '../guards';
import type { PutBody } from '../types';

/**
 * Writes it, once the bucket's content type and size have accepted it. Both
 * guards run before `write` is called, so a refused body is never sent.
 */
export async function putObject<P>(
	context: BucketContext<P>,
	params: P,
	body: PutBody,
	options?: { type?: string },
): Promise<void> {
	const key = keyOf(context, params);
	const type = effectiveType(body, options?.type);
	checkType(context, key, type);
	checkSize(context, key, body);
	// The very type `checkType` approved, and nothing else.
	await context.client.write(key, body, type ? { type } : undefined);
}

/** Removes it. S3 does not say whether anything was there, and nor does this. */
export function deleteObject<P>(
	context: BucketContext<P>,
	params: P,
): Promise<void> {
	return context.client.delete(keyOf(context, params));
}
