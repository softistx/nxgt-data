import type { SourceEntry } from '@nxgt/backup';
import type { ClientSession, Db, Timestamp } from 'mongodb';
import { MongoBackupError, serverCode } from '../errors';
import { writeMetadata } from '../format/metadata';
import { DOCUMENTS, METADATA } from '../format/names';
import { after, pinnedCatalog } from './catalog';
import type { CollectionFilter } from './collections';

/** The server refused a read: its snapshot is older than it keeps. */
const SNAPSHOT_TOO_OLD = 239;

/**
 * The cluster's operation time now, read through a session of its own:
 * what a change stream started there misses nothing after.
 */
export async function operationTime(db: Db): Promise<Timestamp> {
	const session = db.client.startSession();
	try {
		await db.command({ ping: 1 }, { session });
		const time = session.operationTime;
		if (!time) {
			throw new MongoBackupError(
				'mongoSource: the server gave no operation time; a backup needs a ' +
					'replica set or a sharded cluster',
				'UNSUPPORTED',
			);
		}
		return time;
	} finally {
		await session.endSession();
	}
}

/** A stream of `text`, as an entry gives it. */
function textStream(text: string): ReadableStream<Uint8Array> {
	return new Response(text).body as ReadableStream<Uint8Array>;
}

/**
 * Every document of one collection, as concatenated BSON — each read raw,
 * so no number changes kind — in the snapshot `session` reads at.
 */
function documentsOf(
	db: Db,
	name: string,
	session: ClientSession,
): ReadableStream<Uint8Array> {
	const cursor = db
		.collection(name)
		.find({}, { session, raw: true, batchSize: 1000 });
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = (await cursor.next()) as Uint8Array | null;
				if (next === null) controller.close();
				else controller.enqueue(next);
			} catch (error) {
				controller.error(
					serverCode(error) === SNAPSHOT_TOO_OLD
						? new MongoBackupError(
								'mongoSource: the snapshot outlived the history the server keeps; ' +
									'raise minSnapshotHistoryWindowInSeconds, or back up fewer ' +
									'collections at a time',
								'SNAPSHOT_TOO_OLD',
								{ cause: error },
							)
						: error,
				);
			}
		},
		async cancel() {
			await cursor.close();
		},
	});
}

/**
 * A full backup's entries: each collection's metadata, then its documents,
 * every document read in one snapshot session — one cluster time for them
 * all — and the metadata read so that it is that time's too. The next
 * backup's change stream starts just after that time, following the
 * collections this one holds — its metadata entries say which.
 */
export async function* snapshotEntries(
	db: Db,
	filter: CollectionFilter | undefined,
	record: (start: Timestamp) => void,
): AsyncGenerator<SourceEntry> {
	const { session, at, catalog } = await pinnedCatalog(db, filter);
	const fingerprint = `snapshot:${at.toString()}`;
	try {
		for (const collection of catalog) {
			const metadata = writeMetadata(collection.metadata);
			yield {
				name: `${METADATA}${collection.name}`,
				fingerprint,
				open: () => textStream(metadata),
			};
			if (collection.type === 'collection') {
				yield {
					name: `${DOCUMENTS}${collection.name}`,
					fingerprint,
					open: () => documentsOf(db, collection.name, session),
				};
			}
		}
		record(after(at));
	} finally {
		await session.endSession();
	}
}
