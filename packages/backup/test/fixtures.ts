import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	generateHybridIdentity,
	generateIdentity,
	identityToRecipient,
} from 'age-encryption';
import type { Repository } from '../src/repository/types';
import type { BackupSource, RestoreTarget } from '../src/source/types';

/** An age key pair: the secret identity, and the recipient to encrypt to. */
export interface KeyPair {
	identity: string;
	recipient: string;
}

export async function keyPair(hybrid = false): Promise<KeyPair> {
	const identity = hybrid
		? await generateHybridIdentity()
		: await generateIdentity();
	return { identity, recipient: await identityToRecipient(identity) };
}

/** A fresh folder under the system's temporary one, and a way to remove it. */
export async function folder(): Promise<{
	path: string;
	remove: () => Promise<void>;
}> {
	const path = await mkdtemp(join(tmpdir(), 'nxgt-backup-spec-'));
	return { path, remove: () => rm(path, { recursive: true, force: true }) };
}

export function streamOf(
	bytes: Uint8Array | string,
): ReadableStream<Uint8Array> {
	return new Response(bytes as BodyInit).body as ReadableStream<Uint8Array>;
}

/** Bytes that do not compress to nothing: a counter mixed into each byte. */
export function bytes(size: number, seed = 1): Uint8Array {
	const out = new Uint8Array(size);
	for (let i = 0; i < size; i++) out[i] = (i * 31 + seed * 7 + (i >> 8)) & 255;
	return out;
}

/** A source over named byte arrays, recording which entries it opened. */
export function memorySource(
	entries: Record<string, Uint8Array | string>,
): BackupSource & { opened: string[] } {
	const opened: string[] = [];
	return {
		kind: 'memory',
		opened,
		async *entries() {
			for (const [name, value] of Object.entries(entries)) {
				yield {
					name,
					open: () => {
						opened.push(name);
						return streamOf(value);
					},
				};
			}
		},
	};
}

/** A target keeping what it is given in memory. */
export function memoryTarget(): RestoreTarget & {
	written: Map<string, Uint8Array>;
	attempted: string[];
} {
	const written = new Map<string, Uint8Array>();
	const attempted: string[] = [];
	return {
		written,
		attempted,
		async write(name, stream) {
			attempted.push(name);
			written.set(
				name,
				new Uint8Array(await new Response(stream).arrayBuffer()),
			);
		},
	};
}

/**
 * A repository over another one that records every key of a backup put,
 * and fails every such put once `failFrom` have gone through. Lock files
 * pass through unrecorded: they are the lock's business, not the backup's.
 */
export function recording(
	inner: Repository,
	options: { name?: string; failFrom?: number } = {},
): Repository & { puts: string[] } {
	const puts: string[] = [];
	return {
		name: options.name ?? inner.name,
		puts,
		async put(key, file) {
			if (key.split('/')[1] === 'locks') return inner.put(key, file);
			if (options.failFrom !== undefined && puts.length >= options.failFrom) {
				throw new Error('the store is unreachable');
			}
			puts.push(key);
			await inner.put(key, file);
		},
		get: (key) => inner.get(key),
		list: (prefix) => inner.list(prefix),
		delete: (key) => inner.delete(key),
	};
}
