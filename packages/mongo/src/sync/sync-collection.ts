import type { ClientSession, Db } from 'mongodb';
import type { AnyCollectionDefinition } from '../definition/define-collection';
import {
	applyIndexes,
	applyOptions,
	applyValidation,
	createCollection,
	type IndexesReport,
	type OptionsReport,
	type SyncStep,
	type ValidatorOutcome,
	validationFor,
} from './phases';
import { liveOptions } from './server';

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
	validator: ValidatorOutcome;
	options: OptionsReport;
	indexes: IndexesReport;
	dryRun: boolean;
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
	const dryRun = options.dryRun ?? false;
	const step: SyncStep = { db, definition, session: options.session, dryRun };
	const wanted = validationFor(definition);

	let live = await liveOptions(db, definition.name, step.session);
	let created = !live;
	let validator: ValidatorOutcome = 'unchanged';

	if (!live) {
		if (wanted.validator !== undefined) validator = 'created';
		if (!dryRun) {
			// Another sync may have created it first: then it is theirs, and it
			// is compared like any other collection that was already there.
			live = await createCollection(step, wanted);
			if (live) {
				created = false;
				validator = 'unchanged';
			}
		}
	}

	const optionsReport = await applyOptions(step, live);
	validator = (await applyValidation(step, wanted, live)) ?? validator;
	const indexes = await applyIndexes(
		step,
		created,
		options.dropUnknownIndexes ?? false,
	);

	return {
		name: definition.name,
		created,
		validator,
		options: optionsReport,
		indexes,
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
