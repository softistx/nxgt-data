import {
	BSON,
	type ClientSession,
	type Db,
	type Document,
	type Timestamp,
} from 'mongodb';
import { MongoBackupError, serverCode } from '../errors';
import type { Metadata } from '../format/metadata';
import { type CollectionFilter, type Listed, listed } from './collections';

/** The server found no collection by that name. */
const NAMESPACE_NOT_FOUND = 26;

/** How many times the pin is taken again while the collections change. */
const ATTEMPTS = 5;

/** A collection or a view, with what a backup records of it besides its documents. */
export interface Described extends Listed {
	metadata: Metadata;
}

/** Its indexes, `_id` apart, as `listIndexes` gave them less `v` and `ns`. */
async function indexesOf(db: Db, collection: Listed): Promise<Document[]> {
	if (collection.type === 'view') return [];
	const indexes = await db.collection(collection.name).listIndexes().toArray();
	return indexes
		.filter((index) => index['name'] !== '_id_')
		.map(({ v: _v, ns: _ns, ...index }) => index);
}

/**
 * The collections and views the filter takes, each with its options and
 * indexes — or nothing when one went while they were being read.
 */
async function describe(
	db: Db,
	filter: CollectionFilter | undefined,
): Promise<Described[] | undefined> {
	const found: Described[] = [];
	try {
		for (const collection of await listed(db, filter)) {
			const indexes = await indexesOf(db, collection);
			found.push({
				...collection,
				metadata: {
					type: collection.type,
					options: collection.options,
					indexes,
				},
			});
		}
	} catch (error) {
		if (serverCode(error) === NAMESPACE_NOT_FOUND) return undefined;
		throw error;
	}
	return found;
}

/**
 * A snapshot session with its cluster time fixed: a session takes the time
 * of its first read, so one is made at once — a `distinct` on a
 * collection no one has, which reads nothing and is the read whose reply
 * carries that time — rather than whenever the first entry is opened.
 */
async function pin(db: Db): Promise<{ session: ClientSession; at: Timestamp }> {
	const session = db.client.startSession({ snapshot: true });
	try {
		await db
			.collection(`nxgt-snapshot-${crypto.randomUUID()}`)
			.distinct('_id', {}, { session });
		const at = (session as { snapshotTime?: Timestamp }).snapshotTime;
		if (!at) {
			throw new MongoBackupError(
				'mongoSource: the server gave no snapshot time; a backup needs a ' +
					'replica set or a sharded cluster',
				'UNSUPPORTED',
			);
		}
		return { session, at };
	} catch (error) {
		await session.endSession();
		throw error;
	}
}

const same = (a: Described[] | undefined, b: Described[] | undefined) =>
	a !== undefined &&
	b !== undefined &&
	BSON.EJSON.stringify(a, { relaxed: false }) ===
		BSON.EJSON.stringify(b, { relaxed: false });

/**
 * The snapshot, and what it holds besides documents. The collections, their
 * options and their indexes are not read in a snapshot — the server does
 * not serve those reads at a cluster time — so they are read before the
 * pin and again after it: the same both times, they are what the snapshot
 * holds. Otherwise the pin is taken again, up to five times, then
 * `CHANGING`.
 */
export async function pinnedCatalog(
	db: Db,
	filter: CollectionFilter | undefined,
): Promise<{ session: ClientSession; at: Timestamp; catalog: Described[] }> {
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const before = await describe(db, filter);
		const pinned = await pin(db);
		const after = await describe(db, filter).catch(async (error: unknown) => {
			await pinned.session.endSession();
			throw error;
		});
		if (same(before, after)) {
			return { ...pinned, catalog: after as Described[] };
		}
		await pinned.session.endSession();
	}
	throw new MongoBackupError(
		'mongoSource: the collections or their indexes kept changing while the ' +
			'snapshot was taken; try again when they settle',
		'CHANGING',
	);
}

/** The first cluster time after `at`: what the snapshot read at `at` does not hold. */
export function after(at: Timestamp): Timestamp {
	return at.i === 0xffffffff
		? new BSON.Timestamp({ t: at.t + 1, i: 0 })
		: new BSON.Timestamp({ t: at.t, i: at.i + 1 });
}
