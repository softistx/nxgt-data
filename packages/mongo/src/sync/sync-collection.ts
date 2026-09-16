import type {
	ClientSession,
	Db,
	Document,
	IndexDescription,
	IndexDescriptionInfo,
} from 'mongodb';
import type { AnyCollectionDefinition } from '../definition/define-collection';
import { toMongoJsonSchema } from '../definition/json-schema';
import { DataError } from '../errors/data-error';
import { toDataError } from '../errors/to-data-error';
import { diffIndexes, normalizeIndex } from './index-diff';
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
	 * a deploy.
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
	indexes: {
		created: string[];
		/** There with other options: MongoDB cannot change one, so it is dropped and built again. */
		recreated: string[];
		dropped: string[];
		unchanged: string[];
	};
	dryRun: boolean;
}

function serverCode(error: unknown): number | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'number' ? code : undefined;
}

async function collectionOptions(
	db: Db,
	name: string,
	session: ClientSession | undefined,
): Promise<LiveValidation | undefined> {
	// `nameOnly: false` is what types the answer as the whole entry: without
	// it the driver's overload gives back a name and a type alone.
	const [info] = await db
		.listCollections(
			{ name },
			{ ...(session ? { session } : {}), nameOnly: false },
		)
		.toArray();
	return info ? ((info.options ?? {}) as LiveValidation) : undefined;
}

/** The indexes of a collection, or none when it does not exist yet. */
async function liveIndexes(
	db: Db,
	name: string,
	session: ClientSession | undefined,
): Promise<IndexDescriptionInfo[]> {
	try {
		return await db.collection(name).indexes({ session });
	} catch (error) {
		// NamespaceNotFound: nothing is there, so nothing is indexed.
		if (serverCode(error) === 26) return [];
		throw error;
	}
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

function creationOptions(wanted: WantedValidation): Document {
	return wanted.validator === undefined
		? {}
		: {
				validator: wanted.validator,
				validationLevel: wanted.level,
				validationAction: wanted.action,
			};
}

async function writeValidation(
	db: Db,
	name: string,
	wanted: WantedValidation,
	session: ClientSession | undefined,
): Promise<void> {
	try {
		await db.command(
			{
				collMod: name,
				// An empty validator is how one is removed: the key then goes
				// away entirely, and the level and the action stay behind.
				validator: wanted.validator ?? {},
				...(wanted.validator === undefined
					? {}
					: { validationLevel: wanted.level, validationAction: wanted.action }),
			},
			session ? { session } : undefined,
		);
	} catch (error) {
		if (serverCode(error) === 13) {
			throw new DataError(
				`sync: not allowed to run collMod on "${name}". Writing a validator ` +
					'needs the `collMod` action, which `readWrite` does not grant and ' +
					'`dbAdmin` does: sync with a role that has it, not with the ' +
					'application’s own user.',
				{ collection: name, serverCode: 13, cause: error },
			);
		}
		throw toDataError(error, { collection: name });
	}
}

/**
 * Brings one collection in line with its definition, and says what it changed:
 *
 * 1. creates the collection, with its validator, when it is missing;
 * 2. writes the validator with `collMod` when it differs from the definition's;
 * 3. creates the indexes that are missing, and rebuilds those whose options
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

	let live = await collectionOptions(db, name, session);
	let created = false;
	let validator: SyncReport['validator'] = 'unchanged';

	if (!live) {
		created = true;
		if (wanted.validator !== undefined) validator = 'created';
		if (!dryRun) {
			try {
				await db.createCollection(name, {
					...creationOptions(wanted),
					...(session ? { session } : {}),
				});
			} catch (error) {
				// NamespaceExists: another sync created it between the lookup and
				// the creation. Go on with theirs, which is compared below.
				if (serverCode(error) !== 48) {
					throw toDataError(error, { collection: name });
				}
				created = false;
				validator = 'unchanged';
				live = await collectionOptions(db, name, session);
			}
		}
	}

	if (live && !validationMatches(wanted, live)) {
		validator =
			wanted.validator === undefined
				? 'removed'
				: hasValidator(live)
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
