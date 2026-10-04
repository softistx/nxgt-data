import type { Db, IndexDescription } from 'mongodb';
import { MongoBackupError, serverCode } from '../errors';
import type { Described } from '../source/catalog';
import { dropIfThere, exists, isView } from '../target/collection';
import type { DocumentSelection } from './options';

/** The server refused a name already taken. */
const NAMESPACE_EXISTS = 48;

/** One collection or view of the backup, and the name it lands under. */
export interface Chosen {
	described: Described;
	as: string;
}

export function taken(): MongoBackupError {
	return new MongoBackupError(
		'restoreCollections: a collection or view to restore is already in the ' +
			'database; restore it under another name, or pass replace: true',
		'EXISTS',
	);
}

/**
 * Each collection moved from `scratch` into `db` whole — a rename across
 * databases, which keeps its options and indexes — then each view made
 * again: on the collection's new name when that collection came too.
 * Without `replace`, a name taken is refused before anything moves, and
 * the rename itself refuses one taken meanwhile.
 */
export async function landWhole(
	scratch: Db,
	db: Db,
	chosen: readonly Chosen[],
	replace: boolean,
): Promise<void> {
	if (!replace) {
		for (const { as } of chosen) if (await exists(db, as)) throw taken();
	}
	const renamed = new Map(chosen.map((c) => [c.described.name, c.as]));
	const admin = db.client.db('admin');
	for (const { described, as } of chosen) {
		if (described.type === 'view') continue;
		// The server renames over a collection, never over a view.
		if (replace && (await isView(db, as))) await dropIfThere(db, as);
		await admin
			.command({
				renameCollection: `${scratch.databaseName}.${described.name}`,
				to: `${db.databaseName}.${as}`,
				dropTarget: replace,
			})
			.catch((error: unknown) => {
				throw serverCode(error) === NAMESPACE_EXISTS ? taken() : error;
			});
	}
	for (const { described, as } of chosen) {
		if (described.type !== 'view') continue;
		const { viewOn, ...options } = described.metadata.options;
		if (replace) await dropIfThere(db, as);
		await db
			.createCollection(as, {
				...options,
				viewOn: renamed.get(viewOn as string) ?? viewOn,
			})
			.catch((error: unknown) => {
				throw serverCode(error) === NAMESPACE_EXISTS ? taken() : error;
			});
	}
}

/**
 * The documents `selection` takes from each collection in `scratch`,
 * merged into the one `db` has under its name — made first, with the
 * backup's options and indexes, when there is none. Views hold no
 * documents and are passed over. Says how many each collection gave.
 */
export async function landDocuments(
	scratch: Db,
	db: Db,
	chosen: readonly Chosen[],
	selection: DocumentSelection,
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	for (const { described, as } of chosen) {
		if (described.type === 'view') continue;
		if (!(await exists(db, as))) await createLike(db, as, described);
		const from = scratch.collection(described.name);
		counts.set(described.name, await from.countDocuments(selection.filter));
		await from
			.aggregate(
				[
					{ $match: selection.filter },
					{
						$merge: {
							into: { db: db.databaseName, coll: as },
							on: '_id',
							whenMatched:
								selection.existing === 'replace' ? 'replace' : 'keepExisting',
							whenNotMatched: 'insert',
						},
					},
				],
				{ bypassDocumentValidation: true },
			)
			.toArray();
	}
	return counts;
}

/** A collection made with `described`'s options and indexes; one made meanwhile is kept. */
async function createLike(db: Db, as: string, described: Described) {
	await db
		.createCollection(as, described.metadata.options)
		.catch((error: unknown) => {
			if (serverCode(error) !== NAMESPACE_EXISTS) throw error;
		});
	const { indexes } = described.metadata;
	if (indexes.length > 0) {
		await db.collection(as).createIndexes(indexes as IndexDescription[]);
	}
}
