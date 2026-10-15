import type { S3File, S3Stats } from 'bun';
import { type BucketContext, keyOf } from '../context';
import type { CallOptions } from '../types';
import { deadlineOf, withDeadline } from './deadline';
import { getObject, headObject } from './fetch-object';

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

export async function readBytes<P>(
	context: BucketContext<P>,
	params: P,
	options?: CallOptions,
): Promise<Uint8Array | undefined> {
	const key = keyOf(context, params);
	const timeoutMs = deadlineOf(context, key, 'bytes', options);
	if (timeoutMs === undefined) {
		return whenPresent(context, params, (file) => file.bytes());
	}
	return withDeadline(context, key, 'bytes', timeoutMs, (signal) =>
		getObject(context, key, signal),
	);
}

export async function readText<P>(
	context: BucketContext<P>,
	params: P,
	options?: CallOptions,
): Promise<string | undefined> {
	const key = keyOf(context, params);
	const timeoutMs = deadlineOf(context, key, 'text', options);
	if (timeoutMs === undefined) {
		return whenPresent(context, params, (file) => file.text());
	}
	return withDeadline(context, key, 'text', timeoutMs, async (signal) => {
		const found = await getObject(context, key, signal);
		return found && new TextDecoder().decode(found);
	});
}

export async function statObject<P>(
	context: BucketContext<P>,
	params: P,
	options?: CallOptions,
): Promise<S3Stats | undefined> {
	const key = keyOf(context, params);
	const timeoutMs = deadlineOf(context, key, 'stat', options);
	if (timeoutMs === undefined) {
		return whenPresent(context, params, (file) => file.stat());
	}
	return withDeadline(context, key, 'stat', timeoutMs, (signal) =>
		headObject(context, key, signal),
	);
}

export async function objectExists<P>(
	context: BucketContext<P>,
	params: P,
	options?: CallOptions,
): Promise<boolean> {
	const key = keyOf(context, params);
	const timeoutMs = deadlineOf(context, key, 'exists', options);
	if (timeoutMs === undefined) return context.client.exists(key);
	return withDeadline(
		context,
		key,
		'exists',
		timeoutMs,
		async (signal) => (await headObject(context, key, signal)) !== undefined,
	);
}
