import type { S3Client } from 'bun';
import { MANIFEST_MAX_BYTES } from '../format/manifest';
import { isKeyPath } from './keys';
import type { Repository } from './types';

export interface S3RepositoryOptions {
	/**
	 * Bun's own client, with its bucket, endpoint and credentials: they stay
	 * with you, and nothing here reads or prints them.
	 */
	client: S3Client;
	/**
	 * A folder inside the bucket every key goes under, such as `backups`.
	 * Segments as for a key: letters, digits, `.`, `_`, `-`. None by default.
	 */
	prefix?: string | undefined;
	/** How it is named in outcomes and errors. `s3` by default. Never a credential. */
	name?: string | undefined;
	/**
	 * The part size of a multipart upload, for an object over 64 MiB. 16 MiB
	 * by default; S3 takes 5 MiB at least, and 10 000 parts at most.
	 */
	partSize?: number | undefined;
}

const MIN_PART = 5 * 1024 * 1024;

/**
 * Up to this size an object goes in one PUT, from bytes in memory: S3 makes
 * it visible whole or not at all. It is the manifest's own cap, so the
 * manifest and its signature — what a reader trusts first — always go that
 * way. Raising one is a decision about the other.
 */
const SINGLE_PUT_MAX_BYTES = MANIFEST_MAX_BYTES;

function codeOf(error: unknown): unknown {
	return typeof error === 'object' && error !== null && 'code' in error
		? error.code
		: undefined;
}

/**
 * `stream`, or `undefined` when its first read finds no such key. Reading
 * is what asks: a HEAD first would cost a round trip, and leave a window in
 * which an object deleted between the two fails the stream instead.
 */
async function present(
	stream: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array> | undefined> {
	const reader = stream.getReader();
	let first: Awaited<ReturnType<typeof reader.read>>;
	try {
		first = await reader.read();
	} catch (error) {
		if (codeOf(error) === 'NoSuchKey') return undefined;
		throw error;
	}
	let pending: typeof first | undefined = first;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = pending ?? (await reader.read());
			pending = undefined;
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel: (reason) => reader.cancel(reason),
	});
}

/**
 * Uploads `file` in parts, one part read from disk at a time. Measured on
 * Bun 1.4.2 with 256 MiB: fed the chunks of `Bun.file().stream()`, the
 * writer held +680 MB whether or not it was flushed; fed one `slice` of
 * `partSize` at a time, each followed by `flush` — which waits for the parts
 * in flight, since `write` only queues — it held +80 MB at 16 MiB parts.
 * A part S3 refuses is retried, then
 * the upload is aborted by Bun and `end()` rejects. A local read that fails
 * is the other way out, and there Bun has no abort: `end()` completes what
 * it was given, so that object is deleted straight after.
 */
async function upload(
	client: S3Client,
	key: string,
	file: string,
	partSize: number,
): Promise<void> {
	const writer = client.file(key).writer({ partSize });
	try {
		const source = Bun.file(file);
		for (let start = 0; start < source.size; start += partSize) {
			writer.write(await source.slice(start, start + partSize).bytes());
			await writer.flush();
		}
	} catch (error) {
		await Promise.resolve(writer.end()).catch(() => undefined);
		await client.delete(key).catch(() => undefined);
		throw error;
	}
	await writer.end();
}

/**
 * A repository in an S3 bucket — AWS, or any S3-compatible store — on
 * Bun's own `S3Client`. Up to 64 MiB an object goes in one PUT, which S3
 * makes visible whole or not at all; a larger one in parts — see `upload`
 * for the one case that leaves part of it behind for a moment. Either way
 * the object's size is read back before `put` resolves: a write that
 * reports success without storing is caught there, not on the day of a
 * restore.
 */
export function s3Repository(options: S3RepositoryOptions): Repository {
	const { client } = options;
	const prefix = options.prefix ?? '';
	if (prefix !== '' && !isKeyPath(prefix)) {
		throw new TypeError(
			's3Repository: prefix must be a relative path of plain segments',
		);
	}
	const partSize = options.partSize ?? 16 * 1024 * 1024;
	if (!Number.isInteger(partSize) || partSize < MIN_PART) {
		throw new TypeError('s3Repository: partSize must be 5 MiB at least');
	}
	const base = prefix === '' ? '' : `${prefix}/`;
	const keyOf = (key: string): string => {
		if (!isKeyPath(key)) {
			throw new TypeError('s3 repository: a key is not a relative path');
		}
		return `${base}${key}`;
	};
	return {
		name: options.name ?? 's3',
		async put(key, file) {
			const target = keyOf(key);
			const size = Bun.file(file).size;
			if (size <= SINGLE_PUT_MAX_BYTES) {
				await client.write(target, await Bun.file(file).bytes());
			} else {
				await upload(client, target, file, partSize);
			}
			const stored = await client.file(target).stat();
			if (stored.size !== size) {
				throw new Error('s3 repository: an object was not stored whole');
			}
		},
		async get(key) {
			return present(client.file(keyOf(key)).stream());
		},
		list(listed) {
			const trimmed = listed.endsWith('/') ? listed.slice(0, -1) : listed;
			if (trimmed !== '' && !isKeyPath(trimmed)) {
				throw new TypeError('s3 repository: a key is not a relative path');
			}
			const wanted = `${base}${listed}`;
			return (async function* () {
				let continuationToken: string | undefined;
				do {
					const page = await client.list({
						prefix: wanted,
						...(continuationToken ? { continuationToken } : {}),
					});
					for (const found of page.contents ?? []) {
						if (found.key) yield found.key.slice(base.length);
					}
					if (page.isTruncated && !page.nextContinuationToken) {
						// Stopping here would be a listing that looks whole.
						throw new Error(
							's3 repository: a listing page was cut short with no way to go on',
						);
					}
					continuationToken = page.isTruncated
						? page.nextContinuationToken
						: undefined;
				} while (continuationToken);
			})();
		},
		async delete(key) {
			await client.delete(keyOf(key));
		},
	};
}
