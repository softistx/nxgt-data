import type { ClientSession, Db, Document, IndexDescription } from 'mongodb';
import { creationOptionsOf } from '../definition/collection-options';
import type { AnyCollectionDefinition } from '../definition/define-collection';
import { toMongoJsonSchema } from '../definition/json-schema';
import { toDataError } from '../errors/to-data-error';
import { diffIndexes, normalizeIndex } from './index-diff';
import {
	collModForOptions,
	diffCollectionOptions,
	immutableOptionsError,
	type OptionMismatch,
} from './options-diff';
import {
	liveIndexes,
	liveOptions,
	serverCode,
	writeOptions,
	writeValidation,
} from './server';
import {
	hasValidator,
	type LiveValidation,
	validationMatches,
	type WantedValidation,
} from './validator-diff';

export interface SyncOptions {
	/**
	 * Compare and report, but send nothing: no collection is created, no
	 * validator written, no index touched. For a check in CI, or a look before
	 * a deploy. An option that cannot be changed is reported here rather than
	 * thrown, so one run lists everything that is wrong at once.
	 */
	dryRun?: boolean;
	/**
	 * Drop the indexes the server has and no definition names. Off by default:
	 * an index someone added on purpose is not this package's to remove.
	 * `_id_` is never dropped, and cannot be.
	 */
	dropUnknownIndexes?: boolean;
	/**
	 * A session for the reads. MongoDB does not allow `collMod` or an index
	 * build inside a transaction, so do not pass one that is in a transaction.
	 */
	session?: ClientSession;
}

/** What `sync` found and did to one collection. */
export interface SyncReport {
	name: string;
	/** The collection did not exist, and was created. */
	created: boolean;
	/** What the `$jsonSchema` validator needed. */
	validator: 'unchanged' | 'created' | 'updated' | 'removed';
	/** MongoDB's own collection options. */
	options: {
		/** Those `collMod` changed, by name: `capped.size`, `expireAfterSeconds`. */
		changed: string[];
		/**
		 * Those the live collection disagrees on and MongoDB cannot change.
		 * Outside `dryRun` this is always empty: sync throws instead.
		 */
		immutable: OptionMismatch[];
	};
	indexes: {
		created: string[];
		/** There with other options: MongoDB cannot change one, so it is dropped and built again. */
		recreated: string[];
		dropped: string[];
		unchanged: string[];
	};
	dryRun: boolean;
}

function validationFor(definition: AnyCollectionDefinition): WantedValidation {
	const { level, action } = definition.validation;
	return {
		validator:
			level === 'off'
				? undefined
				: { $jsonSchema: toMongoJsonSchema(definition.schema) },
		level,
		action,
	};
}

/** Everything `createCollection` takes: the options, plus the validator. */
function creationOptions(
	definition: AnyCollectionDefinition,
	wanted: WantedValidation,
): Document {
	return {
		...creationOptionsOf(definition.options),
		...(wanted.validator === undefined
			? {}
			: {
					validator: wanted.validator,
					validationLevel: wanted.level,
					validationAction: wanted.action,
				}),
	};
}

/** Creates the collection, or says it was already there. */
async function createIfMissing(
	db: Db,
	definition: AnyCollectionDefinition,
	wanted: WantedValidation,
	session: ClientSession | undefined,
): Promise<Document | undefined> {
	try {
		await db.createCollection(definition.name, {
			...creationOptions(definition, wanted),
			...(session ? { session } : {}),
		});
		return undefined;
	} catch (error) {
		// NamespaceExists: another sync created it between the lookup and the
		// creation. Go on with theirs, which is compared like any other.
		if (serverCode(error) !== 48) {
			throw toDataError(error, { collection: definition.name });
		}
		return (await liveOptions(db, definition.name, session)) ?? {};
	}
}

/**
 * Brings one collection in line with its definition, and says what it changed:
 *
 * 1. creates the collection, with its options and its validator, when it is
 *    missing;
 * 2. changes the collection options `collMod` accepts, and **throws** on a
 *    difference MongoDB cannot change — a collation, a clustered index, or
 *    making an existing collection capped are decided once, at creation;
 * 3. writes the validator with `collMod` when it differs from the definition's;
 * 4. creates the indexes that are missing, and rebuilds those whose options
 *    changed — MongoDB refuses to alter an index in place.
 *
 * Run it twice and the second run sends nothing.
 *
 * ```ts
 * const report = await syncCollection(db, users);
 * // { created: true, validator: 'created', indexes: { created: ['users_email_unique'], … } }
 * ```
 *
 * It is a deployment step, not a request-time one: `collMod` needs the
 * `dbAdmin` role, and neither it nor an index build may run in a transaction.
 */
export async function syncCollection(
	db: Db,
	definition: AnyCollectionDefinition,
	options: SyncOptions = {},
): Promise<SyncReport> {
	const { name } = definition;
	const dryRun = options.dryRun ?? false;
	const session = options.session;
	const wanted = validationFor(definition);

	let live = await liveOptions(db, name, session);
	let created = false;
	let validator: SyncReport['validator'] = 'unchanged';

	if (!live) {
		created = true;
		if (wanted.validator !== undefined) validator = 'created';
		if (!dryRun) {
			const existing = await createIfMissing(db, definition, wanted, session);
			if (existing) {
				created = false;
				validator = 'unchanged';
				live = existing;
			}
		}
	}

	const mismatches = live
		? diffCollectionOptions(definition.options, live)
		: [];
	const immutable = mismatches.filter((m) => !m.mutable);
	if (immutable.length > 0 && !dryRun)
		throw immutableOptionsError(name, immutable);
	const changed = mismatches.filter((m) => m.mutable).map((m) => m.option);
	if (changed.length > 0 && !dryRun) {
		await writeOptions(db, name, collModForOptions(mismatches), session);
	}

	if (live && !validationMatches(wanted, live as LiveValidation)) {
		validator =
			wanted.validator === undefined
				? 'removed'
				: hasValidator(live as LiveValidation)
					? 'updated'
					: 'created';
		if (!dryRun) await writeValidation(db, name, wanted, session);
	}

	const existing =
		dryRun && created ? [] : await liveIndexes(db, name, session);
	const diff = diffIndexes(definition.indexes, existing);
	const dropped = options.dropUnknownIndexes ? diff.extra : [];
	const build: IndexDescription[] = [...diff.create, ...diff.recreate];

	if (!dryRun) {
		const collection = db.collection(name);
		for (const index of [
			...diff.recreate.map((i) => normalizeIndex(i).name),
			...dropped,
		]) {
			await collection.dropIndex(index, session ? { session } : undefined);
		}
		if (build.length > 0) {
			try {
				await collection.createIndexes(
					build,
					session ? { session } : undefined,
				);
			} catch (error) {
				throw toDataError(error, { collection: name });
			}
		}
	}

	return {
		name,
		created,
		validator,
		options: { changed, immutable: dryRun ? immutable : [] },
		indexes: {
			created: diff.create.map((index) => normalizeIndex(index).name),
			recreated: diff.recreate.map((index) => normalizeIndex(index).name),
			dropped,
			unchanged: diff.unchanged,
		},
		dryRun,
	};
}

/**
 * `syncCollection` for each definition, one after the other, in the order
 * given. The first that throws stops the rest.
 */
export async function syncCollections(
	db: Db,
	definitions: readonly AnyCollectionDefinition[],
	options: SyncOptions = {},
): Promise<SyncReport[]> {
	const reports: SyncReport[] = [];
	for (const definition of definitions) {
		reports.push(await syncCollection(db, definition, options));
	}
	return reports;
}
