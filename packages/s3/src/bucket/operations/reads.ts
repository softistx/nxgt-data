import type { S3File, S3Stats } from 'bun';
import { type BucketContext, keyOf } from '../context';

/**
 * `undefined` rather than a throw when the object is simply not there.
 *
 * It reads straight away and catches the service's own `NoSuchKey`, rather
 * than asking `exists` first: one round trip instead of two, and no window in
 * which an object deleted between the two turns a promised `undefined` into a
 * throw. `stat` is itself a HEAD, so asking first bought nothing at all.
 */
async function whenPresent<P, T>(
	context: BucketContext<P>,
	params: P,
	read: (file: S3File) => Promise<T>,
): Promise<T | undefined> {
	try {
		return await read(context.client.file(keyOf(context, params)));
	} catch (reason) {
		// Bun names its own S3 failures `S3Error` too, and carries S3's code.
		if ((reason as { code?: unknown }).code === 'NoSuchKey') return undefined;
		throw reason;
	}
}

export function readBytes<P>(
	context: BucketContext<P>,
	params: P,
): Promise<Uint8Array | undefined> {
	return whenPresent(context, params, (file) => file.bytes());
}

export function readText<P>(
	context: BucketContext<P>,
	params: P,
): Promise<string | undefined> {
	return whenPresent(context, params, (file) => file.text());
}

export function statObject<P>(
	context: BucketContext<P>,
	params: P,
): Promise<S3Stats | undefined> {
	return whenPresent(context, params, (file) => file.stat());
}

export function objectExists<P>(
	context: BucketContext<P>,
	params: P,
): Promise<boolean> {
	return context.client.exists(keyOf(context, params));
}
