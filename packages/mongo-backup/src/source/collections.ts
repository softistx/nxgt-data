import { BSON, type Db, type Document } from 'mongodb';
import { MongoBackupError } from '../errors';

/** Which collections a backup reads: their names, or a test on each name. */
export type CollectionFilter = readonly string[] | ((name: string) => boolean);

/** A collection or a view, as `listCollections` described it. */
export interface Listed {
	name: string;
	type: 'collection' | 'view';
	options: Document;
	/** Its UUID, as Extended JSON: a collection dropped and made again has another. */
	uuid: string;
}

/** Whether `name` is one the filter takes; `system.*` never is. */
export function takes(
	filter: CollectionFilter | undefined,
	name: string,
): boolean {
	if (name.startsWith('system.')) return false;
	if (filter === undefined) return true;
	return typeof filter === 'function' ? filter(name) : filter.includes(name);
}

/**
 * The collections and views the filter takes, sorted by name. A name the
 * filter lists that the database lacks is a `TypeError`: a typo would
 * otherwise back up nothing, and say nothing.
 */
export async function listed(
	db: Db,
	filter: CollectionFilter | undefined,
): Promise<Listed[]> {
	const all = await db.listCollections({}, { nameOnly: false }).toArray();
	const found: Listed[] = [];
	for (const info of all) {
		if (!takes(filter, info.name)) continue;
		if (info.type !== 'collection' && info.type !== 'view') {
			throw new MongoBackupError(
				'mongoSource: a collection is of a type this version does not back up ' +
					'(a time-series one); leave it out with collections',
				'UNSUPPORTED',
			);
		}
		found.push({
			name: info.name,
			type: info.type,
			options: (info as { options?: Document }).options ?? {},
			uuid: BSON.EJSON.stringify(
				(info as { info?: { uuid?: unknown } }).info?.uuid ?? null,
			),
		});
	}
	if (Array.isArray(filter)) {
		const names = new Set(found.map((c) => c.name));
		if (!filter.every((name) => names.has(name))) {
			throw new TypeError(
				'mongoSource: a collection named in collections is not in the database',
			);
		}
	}
	return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
