import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import type { RestoreTarget } from '@nxgt/backup';
import type { Db } from 'mongodb';
import { MongoBackupError } from '../errors';
import { type Metadata, readMetadata } from '../format/metadata';
import { parseName } from '../format/names';
import { restoreChanges } from './changes';
import { restoreCollection, restoreView } from './collection';

export interface MongoTargetOptions {
	/** The database to restore into: the one backed up, or another. */
	db: Db;
	/**
	 * Replace a collection or view already there. `false` by default: one
	 * there is refused with `EXISTS`, and nothing of it is touched.
	 */
	replace?: boolean | undefined;
	/** Where a `changes/<n>` entry is staged before it applies. The system's temporary folder by default. */
	tmpDir?: string | undefined;
}

/** The longest metadata entry read: options and indexes, never documents. */
const METADATA_MAX_BYTES = 16 * 1024 * 1024;

const malformed = (what: string) =>
	new MongoBackupError(`mongoTarget: ${what}`, 'MALFORMED');

async function metadataFrom(
	stream: ReadableStream<Uint8Array>,
): Promise<Metadata> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of stream) {
		size += chunk.length;
		if (size > METADATA_MAX_BYTES) {
			await stream.cancel().catch(() => undefined);
			throw malformed('a metadata entry is larger than 16 MiB');
		}
		chunks.push(chunk);
	}
	const metadata = readMetadata(
		new TextDecoder().decode(Buffer.concat(chunks)),
	);
	if (!metadata)
		throw malformed('a metadata entry is not one this version wrote');
	return metadata;
}

function checkOptions(options: MongoTargetOptions): void {
	const db = options?.db as Partial<Db> | undefined;
	if (
		typeof db?.collection !== 'function' ||
		typeof db.databaseName !== 'string'
	) {
		throw new TypeError('mongoTarget: db must be a MongoDB Db');
	}
	if (options.tmpDir !== undefined && !isAbsolute(options.tmpDir)) {
		throw new TypeError('mongoTarget: tmpDir must be an absolute path');
	}
}

/**
 * A MongoDB database as a restore target. Takes the entries a
 * `mongoSource` backup holds, in their order: each collection's metadata,
 * then its documents — landed whole or not at all — then the changes an
 * incremental backup recorded, applied once each entry was read and
 * checked to its end. A view is created from its metadata.
 */
export function mongoTarget(options: MongoTargetOptions): RestoreTarget {
	checkOptions(options);
	const { db } = options;
	const replace = options.replace === true;
	const tmpDir = options.tmpDir ?? tmpdir();
	const metadata = new Map<string, Metadata>();
	return {
		async write(name, stream) {
			const parsed = parseName(name);
			if (!parsed) {
				await stream.cancel();
				throw malformed('an entry name is not one this version writes');
			}
			if (parsed.kind === 'changes') {
				return restoreChanges(db, stream, tmpDir, replace);
			}
			if (parsed.kind === 'metadata') {
				const read = await metadataFrom(stream);
				metadata.set(parsed.collection, read);
				if (read.type === 'view') {
					await restoreView(db, parsed.collection, read, replace);
				}
				return;
			}
			const known = metadata.get(parsed.collection);
			if (!known) {
				await stream.cancel();
				throw malformed('a collection’s documents came before its metadata');
			}
			await restoreCollection(db, parsed.collection, known, stream, replace);
		},
	};
}
