import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
	AnyBulkWriteOperation,
	Db,
	Document,
	IndexDescription,
} from 'mongodb';
import { MongoBackupError, serverCode } from '../errors';
import { bsonDocuments } from '../format/bson-stream';
import { type Change, readChange } from '../format/change';
import { dropIfThere, exists, taken } from './collection';

/** The server found no collection by that name. */
const NAMESPACE_NOT_FOUND = 26;

const BATCH = 1000;

/** The write one document change makes, as a bulk operation. */
function operationsOf(
	change: Extract<Change, { key: Document }>,
): AnyBulkWriteOperation[] {
	switch (change.op) {
		case 'insert':
		case 'replace':
			return [
				{
					replaceOne: {
						filter: change.key,
						replacement: change.doc,
						upsert: true,
					},
				},
			];
		case 'delete':
			return [{ deleteOne: { filter: change.key } }];
		case 'update': {
			// Arrays cut first, as the server reports them, then the fields set.
			const cuts: AnyBulkWriteOperation[] = change.truncated.map((cut) => ({
				updateOne: {
					filter: change.key,
					update: {
						$push: { [cut.field]: { $each: [], $slice: cut.newSize } },
					} as Document,
				},
			}));
			const update: Document = {};
			if (Object.keys(change.set).length > 0) update['$set'] = change.set;
			if (change.unset.length > 0) {
				update['$unset'] = Object.fromEntries(change.unset.map((f) => [f, '']));
			}
			return Object.keys(update).length === 0
				? cuts
				: [...cuts, { updateOne: { filter: change.key, update } }];
		}
	}
}

/** The server refused a name already taken. */
const NAMESPACE_EXISTS = 48;

/** The server found no index by that name. */
const INDEX_NOT_FOUND = 27;

const ignoring =
	(...codes: number[]) =>
	(error: unknown) => {
		if (!codes.includes(serverCode(error) ?? 0)) throw error;
	};

/**
 * A change to a collection itself, or to the database. A collection the
 * changes create that is already there is refused, as a full restore
 * refuses one — or replaced, with `replace`.
 */
async function applyToCollection(
	db: Db,
	change: Exclude<Change, { key: Document }>,
	replace: boolean,
): Promise<void> {
	switch (change.op) {
		case 'create':
			if (await exists(db, change.coll)) {
				if (!replace) throw taken();
				await dropIfThere(db, change.coll);
			}
			await db.createCollection(change.coll, change.options);
			return;
		case 'createIndexes':
			await db
				.collection(change.coll)
				.createIndexes(change.indexes as IndexDescription[]);
			return;
		case 'dropIndexes':
			for (const name of change.names) {
				await db
					.collection(change.coll)
					.dropIndex(name)
					.catch(ignoring(INDEX_NOT_FOUND, NAMESPACE_NOT_FOUND));
			}
			return;
		case 'modify':
			await db
				.command({ collMod: change.coll, ...change.changes })
				.catch(ignoring(NAMESPACE_NOT_FOUND));
			return;
		case 'drop':
			return dropIfThere(db, change.coll);
		case 'rename':
			// A collection the rename did not replace at the source is not
			// one to replace here, unless `replace` says so: the server refuses
			// a name taken, even one taken a moment ago.
			await db
				.renameCollection(change.coll, change.to, {
					dropTarget: change.dropTarget || replace,
				})
				.catch((error: unknown) => {
					if (serverCode(error) === NAMESPACE_EXISTS) throw taken();
					ignoring(NAMESPACE_NOT_FOUND)(error);
				});
			return;
		case 'dropDatabase':
			await db.dropDatabase();
			return;
	}
}

/**
 * Applies the changes staged in `file`, in order: runs of document changes
 * to one collection go as ordered bulk writes, and a change to a
 * collection itself applies between them.
 */
async function applyFile(
	db: Db,
	file: string,
	replace: boolean,
): Promise<void> {
	let coll = '';
	let pending: AnyBulkWriteOperation[] = [];
	const flush = async () => {
		if (pending.length > 0) {
			await db
				.collection(coll)
				.bulkWrite(pending, { ordered: true, bypassDocumentValidation: true });
		}
		pending = [];
	};
	for await (const bytes of bsonDocuments(
		Bun.file(file).stream(),
		'mongoTarget',
	)) {
		const change = readChange(bytes);
		if (!change) {
			throw new MongoBackupError(
				'mongoTarget: a change is not one this version wrote',
				'MALFORMED',
			);
		}
		if (!('key' in change)) {
			await flush();
			await applyToCollection(db, change, replace);
			continue;
		}
		if (change.coll !== coll || pending.length >= BATCH) await flush();
		coll = change.coll;
		pending.push(...operationsOf(change));
	}
	await flush();
}

/**
 * Takes a `changes/<n>` entry: staged to a file in `tmpDir` until its
 * stream has ended cleanly — a change applied is not taken back, so none
 * is applied before the backup's checks have passed — then applied.
 */
export async function restoreChanges(
	db: Db,
	stream: ReadableStream<Uint8Array>,
	tmpDir: string,
	replace: boolean,
): Promise<void> {
	// A folder of its own, which only this user can read: the changes hold
	// whole documents, in the clear.
	const folder = await mkdtemp(join(tmpDir, 'nxgt-mongo-changes-'));
	try {
		const file = join(folder, 'changes.bson');
		await Bun.write(file, new Response(stream));
		await applyFile(db, file, replace);
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}
