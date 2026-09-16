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

/**
 * The steps `syncCollection` runs, one per subject, each deciding and writing
 * its own part of the report. They share what a step needs to reach the
 * server, and nothing else.
 */
export interface SyncStep {
	readonly db: Db;
	readonly definition: AnyCollectionDefinition;
	readonly session: ClientSession | undefined;
	readonly dryRun: boolean;
}

/** What the `$jsonSchema` validator needed. */
export type ValidatorOutcome = 'unchanged' | 'created' | 'updated' | 'removed';

/** MongoDB's own collection options. */
export interface OptionsReport {
	/** Those `collMod` changed, by name: `capped.size`, `expireAfterSeconds`. */
	changed: string[];
	/**
	 * Those the live collection disagrees on and MongoDB cannot change.
	 * Outside `dryRun` this is always empty: sync throws instead.
	 */
	immutable: OptionMismatch[];
}

export interface IndexesReport {
	created: string[];
	/** There with other options: MongoDB cannot change one, so it is dropped and built again. */
	recreated: string[];
	dropped: string[];
	unchanged: string[];
}

export function validationFor(
	definition: AnyCollectionDefinition,
): WantedValidation {
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

/**
 * Creates the collection with its options and its validator. Answers the live
 * options when another sync created it first, and `undefined` when this one
 * did.
 */
export async function createCollection(
	step: SyncStep,
	wanted: WantedValidation,
): Promise<Document | undefined> {
	const { db, definition, session } = step;
	try {
		await db.createCollection(definition.name, {
			...creationOptionsOf(definition.options),
			...(wanted.validator === undefined
				? {}
				: {
						validator: wanted.validator,
						validationLevel: wanted.level,
						validationAction: wanted.action,
					}),
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
 * Changes the options `collMod` accepts, and throws on any other difference
 * before writing anything, so a definition is never half applied.
 */
export async function applyOptions(
	step: SyncStep,
	live: Document | undefined,
): Promise<OptionsReport> {
	const { db, definition, session, dryRun } = step;
	const mismatches = live
		? diffCollectionOptions(definition.options, live)
		: [];
	const immutable = mismatches.filter((m) => !m.mutable);
	if (immutable.length > 0 && !dryRun) {
		throw immutableOptionsError(definition.name, immutable);
	}
	const changed = mismatches.filter((m) => m.mutable).map((m) => m.option);
	if (changed.length > 0 && !dryRun) {
		await writeOptions(
			db,
			definition.name,
			collModForOptions(mismatches),
			session,
		);
	}
	return { changed, immutable: dryRun ? immutable : [] };
}

/** Writes the validator when the live one differs, and says what it did. */
export async function applyValidation(
	step: SyncStep,
	wanted: WantedValidation,
	live: Document | undefined,
): Promise<ValidatorOutcome | undefined> {
	if (!live || validationMatches(wanted, live as LiveValidation)) {
		return undefined;
	}
	if (!step.dryRun) {
		await writeValidation(step.db, step.definition.name, wanted, step.session);
	}
	if (wanted.validator === undefined) return 'removed';
	return hasValidator(live as LiveValidation) ? 'updated' : 'created';
}

/**
 * Creates the missing indexes, and rebuilds those whose options changed —
 * MongoDB refuses to alter an index in place.
 */
export async function applyIndexes(
	step: SyncStep,
	created: boolean,
	dropUnknown: boolean,
): Promise<IndexesReport> {
	const { db, definition, session, dryRun } = step;
	const name = definition.name;
	const existing =
		dryRun && created ? [] : await liveIndexes(db, name, session);
	const diff = diffIndexes(definition.indexes, existing);
	const dropped = dropUnknown ? diff.extra : [];
	const recreated = diff.recreate.map((index) => normalizeIndex(index).name);
	const build: IndexDescription[] = [...diff.create, ...diff.recreate];
	const sessionOption = session ? { session } : undefined;

	if (!dryRun) {
		const collection = db.collection(name);
		for (const index of [...recreated, ...dropped]) {
			await collection.dropIndex(index, sessionOption);
		}
		if (build.length > 0) {
			try {
				await collection.createIndexes(build, sessionOption);
			} catch (error) {
				throw toDataError(error, { collection: name });
			}
		}
	}

	return {
		created: diff.create.map((index) => normalizeIndex(index).name),
		recreated,
		dropped,
		unchanged: diff.unchanged,
	};
}
