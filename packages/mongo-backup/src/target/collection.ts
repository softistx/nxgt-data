import { BSON, type Db, type Document, type IndexDescription } from 'mongodb';
import { MongoBackupError, serverCode } from '../errors';
import { bsonDocuments } from '../format/bson-stream';
import { EXACT } from '../format/change';
import type { Metadata } from '../format/metadata';

/** The server refused a name already taken. */
const NAMESPACE_EXISTS = 48;
/** The server found no collection by that name. */
const NAMESPACE_NOT_FOUND = 26;

const BATCH_DOCUMENTS = 1000;
const BATCH_BYTES = 8 * 1024 * 1024;

export function exists(db: Db, name: string): Promise<boolean> {
	return db
		.listCollections({ name }, { nameOnly: true })
		.toArray()
		.then((found) => found.length > 0);
}

/** Whether `name` is a view in `db`. */
export async function isView(db: Db, name: string): Promise<boolean> {
	const [found] = await db
		.listCollections({ name }, { nameOnly: true })
		.toArray();
	return found?.type === 'view';
}

export function taken(): MongoBackupError {
	return new MongoBackupError(
		'mongoTarget: a collection or view the backup holds is already in the ' +
			'database; restore into another one, or pass replace: true',
		'EXISTS',
	);
}

export async function dropIfThere(db: Db, name: string): Promise<void> {
	await db.dropCollection(name).catch((error: unknown) => {
		if (serverCode(error) !== NAMESPACE_NOT_FOUND) throw error;
	});
}

/** A view, created from its metadata: in place of one there, with `replace`. */
export async function restoreView(
	db: Db,
	name: string,
	metadata: Metadata,
	replace: boolean,
): Promise<void> {
	if (await exists(db, name)) {
		if (!replace) throw taken();
		await dropIfThere(db, name);
	}
	await db.createCollection(name, metadata.options);
}

async function insertAll(
	db: Db,
	staging: string,
	stream: ReadableStream<Uint8Array>,
): Promise<void> {
	const collection = db.collection(staging);
	let batch: Document[] = [];
	let bytes = 0;
	const flush = async () => {
		if (batch.length === 0) return;
		await collection.insertMany(batch, {
			bypassDocumentValidation: true,
			ordered: true,
		});
		batch = [];
		bytes = 0;
	};
	for await (const raw of bsonDocuments(stream, 'mongoTarget')) {
		batch.push(BSON.deserialize(raw, EXACT));
		bytes += raw.length;
		if (batch.length >= BATCH_DOCUMENTS || bytes >= BATCH_BYTES) await flush();
	}
	await flush();
}

/**
 * One collection, landed whole or not at all: created apart under a name
 * of its own with the options it had, filled, indexed, and renamed into
 * place only once its stream ended cleanly — the backup's checks run at
 * the end. Anything that fails on the way drops what was made apart.
 * Without `replace`, a collection already there is refused before any
 * document is read, and the rename itself refuses one made meanwhile.
 */
export async function restoreCollection(
	db: Db,
	name: string,
	metadata: Metadata,
	stream: ReadableStream<Uint8Array>,
	replace: boolean,
): Promise<void> {
	if (!replace && (await exists(db, name))) {
		await stream.cancel();
		throw taken();
	}
	const staging = `nxgt-restore-${crypto.randomUUID()}`;
	try {
		await db.createCollection(staging, metadata.options);
		await insertAll(db, staging, stream);
		if (metadata.indexes.length > 0) {
			await db
				.collection(staging)
				.createIndexes(metadata.indexes as IndexDescription[]);
		}
		// The server renames over a collection, never over a view: with
		// `replace`, one there is dropped first — once the documents landed.
		if (replace && (await isView(db, name))) await dropIfThere(db, name);
		await db
			.collection(staging)
			.rename(name, { dropTarget: replace })
			.catch((error: unknown) => {
				throw serverCode(error) === NAMESPACE_EXISTS ? taken() : error;
			});
	} catch (error) {
		await dropIfThere(db, staging).catch(() => undefined);
		throw error;
	}
}
