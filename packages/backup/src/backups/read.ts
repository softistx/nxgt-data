import type { Decrypter } from 'age-encryption';
import { measure } from '../crypto/measure';
import { zstd } from '../crypto/seal';
import { BackupError } from '../errors/backup-error';
import { type Catalog, readCatalog } from '../format/catalog';
import { isBackupId } from '../format/ids';
import {
	type Manifest,
	readManifest,
	type StoredObject,
} from '../format/manifest';
import type { Repository } from '../repository/types';
import { type BackupContext, keyOf } from './context';

export const MANIFEST = 'manifest.json';

/** Where an error happened, for its message and its fields. */
export interface At {
	call: string;
	id: string;
	repository: Repository;
}

export function failure(
	ctx: BackupContext,
	at: At,
	code: 'NOT_FOUND' | 'INTEGRITY' | 'DECRYPT',
	what: string,
	cause?: unknown,
): BackupError {
	return new BackupError(
		`${at.call} on "${ctx.backup}": ${what} (repository "${at.repository.name}")`,
		{
			code,
			backup: ctx.backup,
			id: at.id,
			repository: at.repository.name,
			cause,
		},
	);
}

/**
 * A backup's manifest, checked: a backup without one does not exist, and
 * one whose manifest names another backup or another id is not this one.
 */
export async function fetchManifest(
	ctx: BackupContext,
	at: At,
): Promise<Manifest> {
	if (!isBackupId(at.id)) {
		throw new TypeError(
			`${at.call} on "${ctx.backup}": the id is not a backup id`,
		);
	}
	const stream = await at.repository.get(keyOf(ctx, at.id, MANIFEST));
	if (!stream) throw failure(ctx, at, 'NOT_FOUND', 'no backup with that id');
	const read = readManifest(await new Response(stream).text());
	if (typeof read === 'string') {
		throw failure(ctx, at, 'INTEGRITY', `the manifest is unreadable: ${read}`);
	}
	if (read.backup !== ctx.backup || read.id !== at.id) {
		throw failure(ctx, at, 'INTEGRITY', 'the manifest is another backup’s');
	}
	return read;
}

/**
 * Copies one object to `path`, checking its size and digest against the
 * manifest before anything reads it: age authenticates each chunk, but
 * anyone with a public key can write a whole new object, and only the
 * manifest says which one this backup wrote.
 */
export async function stage(
	ctx: BackupContext,
	at: At,
	object: StoredObject,
	path: string,
): Promise<void> {
	const stream = await at.repository.get(keyOf(ctx, at.id, object.key));
	if (!stream) throw failure(ctx, at, 'INTEGRITY', 'an object is missing');
	const measured = measure();
	await Bun.write(path, new Response(stream.pipeThrough(measured.stream)));
	const { size, sha256 } = measured.result();
	if (size !== object.size || sha256 !== object.sha256) {
		throw failure(ctx, at, 'INTEGRITY', 'an object differs from its manifest');
	}
}

/** age's decryption of a staged file, with its refusal told apart. */
export async function decrypted(
	ctx: BackupContext,
	at: At,
	open: () => Promise<ReadableStream<Uint8Array>>,
): Promise<ReadableStream<Uint8Array>> {
	try {
		return await open();
	} catch (cause) {
		// The file matched the manifest, so a header age refuses means no
		// identity given was one it was encrypted to.
		throw failure(ctx, at, 'DECRYPT', 'no identity given opens it', cause);
	}
}

/** The catalog of a backup, staged, checked and decrypted. */
export async function fetchCatalog(
	ctx: BackupContext,
	at: At,
	manifest: Manifest,
	decrypter: Decrypter,
	path: string,
): Promise<Catalog> {
	await stage(ctx, at, manifest.catalog, path);
	const stream = await decrypted(
		ctx,
		at,
		async () =>
			(await decrypter.decrypt(
				Bun.file(path).stream(),
			)) as ReadableStream<Uint8Array>,
	);
	let text: string;
	try {
		text = await new Response(stream.pipeThrough(zstd('decompress'))).text();
	} catch (cause) {
		throw failure(ctx, at, 'INTEGRITY', 'the catalog does not decrypt', cause);
	}
	const read = readCatalog(text, manifest.objects.length);
	if (typeof read === 'string') {
		throw failure(ctx, at, 'INTEGRITY', `the catalog is unreadable: ${read}`);
	}
	return read;
}

/**
 * `stream`, with any failure on the way turned into the backup's own:
 * `INTEGRITY`, or the `BackupError` already raised. A restore target then
 * sees one class of error for a damaged entry, apart from its own. `seen`
 * records a clean end: the checks run there, so a reader that stops early
 * has had nothing checked.
 */
export function guarded(
	ctx: BackupContext,
	at: At,
	stream: ReadableStream<Uint8Array>,
	seen: { ended: boolean } = { ended: false },
): ReadableStream<Uint8Array> {
	const reader = stream.getReader();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					seen.ended = true;
					controller.close();
				} else controller.enqueue(value);
			} catch (cause) {
				controller.error(
					cause instanceof BackupError
						? cause
						: failure(ctx, at, 'INTEGRITY', 'an entry does not decrypt', cause),
				);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}
