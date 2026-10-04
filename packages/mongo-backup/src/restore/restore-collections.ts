import type { Db } from 'mongodb';
import { MongoBackupError, renamed } from '../errors';
import { describe } from '../source/catalog';
import { mongoTarget } from '../target/mongo-target';
import { type Chosen, landDocuments, landWhole } from './landing';
import {
	checkOptions,
	destinationOf,
	type RestoreCollectionsOptions,
	type RestoredCollections,
	type Restorer,
} from './options';

/** A scratch database given must hold nothing: it is dropped afterwards. */
async function checkEmpty(scratch: Db, where: string): Promise<void> {
	const held = await scratch.listCollections({}, { nameOnly: true }).toArray();
	if (held.some((info) => !info.name.startsWith('system.'))) {
		throw new MongoBackupError(
			`${where}: the scratch database holds collections; give an empty one`,
			'EXISTS',
		);
	}
}

/**
 * Every key of an `as` record names one restored: a typo would otherwise
 * land that collection under its own name — over the live one.
 */
function checkAsKeys(
	as: RestoreCollectionsOptions['as'],
	described: readonly { name: string }[],
	where: string,
): void {
	if (as === undefined || typeof as === 'function') return;
	const names = new Set(described.map((d) => d.name));
	if (!Object.keys(as).every((key) => names.has(key))) {
		throw new TypeError(`${where}: as names a collection not restored`);
	}
}

/** The collections and views to restore, each with the name it lands under. */
async function choose(
	scratch: Db,
	options: RestoreCollectionsOptions,
	where: string,
): Promise<Chosen[]> {
	const { collections } = options;
	if (Array.isArray(collections)) {
		const held = await scratch
			.listCollections({}, { nameOnly: true })
			.toArray();
		const names = new Set(
			held.map((info) => info.name).filter((n) => !n.startsWith('system.')),
		);
		if (!collections.every((name) => names.has(name))) {
			throw new MongoBackupError(
				`${where}: a collection named in collections is not in the backup`,
				'NOT_FOUND',
			);
		}
	}
	// Views hold no documents: some documents take none of them.
	const described = ((await describe(scratch, collections)) ?? []).filter(
		(d) => !options.documents || d.type !== 'view',
	);
	checkAsKeys(options.as, described, where);
	const chosen = described.map((d) => ({
		described: d,
		as: destinationOf(options.as, d.name, where),
	}));
	if (new Set(chosen.map((c) => c.as)).size !== chosen.length) {
		throw new TypeError(`${where}: as gives two collections one name`);
	}
	return chosen;
}

/**
 * Some of a `mongoSource` backup, chain included, restored into `db`: the
 * collections and views `collections` names, each under the name `as`
 * gives it — whole, or only the documents `documents` selects, merged into
 * what is there. The backup is rebuilt in `scratch` first, then what was
 * asked for is taken from it, and `scratch` is dropped, failed or not.
 */
export function restoreCollections(
	backups: Restorer,
	id: string,
	options: RestoreCollectionsOptions,
): Promise<RestoredCollections> {
	return renamed(
		restoreSome(backups, id, options, 'restoreCollections'),
		'restoreCollections',
	);
}

/** `restoreCollections`, its messages naming the call `where` says. */
export async function restoreSome(
	backups: Restorer,
	id: string,
	options: RestoreCollectionsOptions,
	where: string,
): Promise<RestoredCollections> {
	checkOptions(options, where);
	const { db } = options;
	const scratch =
		options.scratch ?? db.client.db(`nxgt-restore-${crypto.randomUUID()}`);
	if (options.scratch) await checkEmpty(scratch, where);
	try {
		const restored = await backups.restore(
			id,
			mongoTarget({ db: scratch, tmpDir: options.tmpDir }),
			{ identities: options.identities, from: options.from },
		);
		const chosen = await choose(scratch, options, where);
		let counts: Map<string, number> | undefined;
		if (options.documents) {
			counts = await landDocuments(scratch, db, chosen, options.documents);
		} else {
			await landWhole(scratch, db, chosen, options.replace === true, where);
		}
		return {
			...restored,
			collections: chosen.map(({ described, as }) => {
				const documents = counts?.get(described.name);
				return documents === undefined
					? { name: described.name, as }
					: { name: described.name, as, documents };
			}),
		};
	} finally {
		// What the restore did, or its own failure, is what to report: a
		// scratch database left behind is the docs' to explain, not an error.
		await scratch.dropDatabase().catch(() => undefined);
	}
}
