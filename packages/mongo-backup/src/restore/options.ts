import type { Restored, RestoreOptions, RestoreTarget } from '@nxgt/backup';
import type { Db, Document } from 'mongodb';
import { isDocument } from '../format/document';
import type { CollectionFilter } from '../source/collections';

/** What `restoreCollections` needs of a bound backup: its `restore`. */
export interface Restorer {
	restore(
		id: string,
		target: RestoreTarget,
		options: RestoreOptions,
	): Promise<Restored>;
}

/** Some documents of each collection, merged into what is there. */
export interface DocumentSelection {
	/** A query, as `find` takes it: `{ _id: id }`, or any other. */
	filter: Document;
	/** What a document already there with the same `_id` becomes: the backup's, or kept. */
	existing: 'replace' | 'keep';
}

interface Common {
	/** The age secret keys to open the backup with. */
	identities: readonly string[];
	/** The repository to read from, by name. The first one by default. */
	from?: string | undefined;
	/** The database to restore into. */
	db: Db;
	/** The collections and views to restore, by their name at the backup's time. All of them by default. */
	collections?: CollectionFilter | undefined;
	/** The name each one is restored under. Its own by default. */
	as?:
		| Readonly<Record<string, string>>
		| ((name: string) => string)
		| undefined;
	/**
	 * Where the backup is rebuilt first, chain included: an empty database,
	 * dropped afterwards. A fresh `nxgt-restore-<uuid>` on `db`'s client by
	 * default.
	 */
	scratch?: Db | undefined;
	/** Where a `changes/<n>` entry is staged. The system's temporary folder by default. */
	tmpDir?: string | undefined;
}

/** Whole collections and views, each landed whole or not at all. */
interface Whole extends Common {
	documents?: undefined;
	/** Replace a collection or view already there. `false` by default: `EXISTS`. */
	replace?: boolean | undefined;
}

/** Some documents of each collection, merged into the collection there. */
interface Part extends Common {
	documents: DocumentSelection;
	replace?: never;
}

export type RestoreCollectionsOptions = Whole | Part;

/** What was restored: the backup's entries, and each collection and where it went. */
export interface RestoredCollections extends Restored {
	collections: { name: string; as: string; documents?: number }[];
}

const NAME = /^[^$\0]+$/;

/** The name `name` is restored under, checked. */
export function destinationOf(
	as: RestoreCollectionsOptions['as'],
	name: string,
): string {
	const to =
		as === undefined
			? name
			: typeof as === 'function'
				? as(name)
				: Object.hasOwn(as, name)
					? as[name]
					: name;
	if (typeof to !== 'string' || !NAME.test(to) || to.startsWith('system.')) {
		throw new TypeError('restoreCollections: as must give a collection name');
	}
	return to;
}

/** A record `as` is checked at once; a function only once the names are known. */
function checkAs(as: RestoreCollectionsOptions['as']): void {
	if (as === undefined || typeof as === 'function') return;
	const names = Object.keys(as);
	const targets = names.map((name) => destinationOf(as, name));
	if (new Set(targets).size !== targets.length) {
		throw new TypeError(
			'restoreCollections: as gives two collections one name',
		);
	}
}

function isDb(value: unknown): value is Db {
	const db = value as Partial<Db> | undefined;
	return (
		typeof db?.collection === 'function' && typeof db.databaseName === 'string'
	);
}

export function checkOptions(options: RestoreCollectionsOptions): void {
	if (!isDb(options?.db)) {
		throw new TypeError('restoreCollections: db must be a MongoDB Db');
	}
	if (options.scratch !== undefined && !isDb(options.scratch)) {
		throw new TypeError('restoreCollections: scratch must be a MongoDB Db');
	}
	if (
		options.scratch !== undefined &&
		options.scratch.client !== options.db.client
	) {
		throw new TypeError("restoreCollections: scratch must be on db's client");
	}
	if (options.scratch?.databaseName === options.db.databaseName) {
		throw new TypeError('restoreCollections: scratch must be another database');
	}
	checkAs(options.as);
	const { documents } = options;
	if (
		documents !== undefined &&
		(!isDocument(documents?.filter) ||
			(documents.existing !== 'replace' && documents.existing !== 'keep'))
	) {
		throw new TypeError(
			"restoreCollections: documents must be { filter, existing: 'replace' | 'keep' }",
		);
	}
	if (documents !== undefined && options.replace !== undefined) {
		throw new TypeError(
			'restoreCollections: replace is for whole collections; documents says what happens to those there',
		);
	}
}
