import {
	type IndexObject,
	type Meilisearch,
	MeilisearchApiError,
	type Settings,
	type Task,
	type WaitOptions,
} from 'meilisearch';
import type { AnyIndexDefinition } from '../definition/define-index';
import {
	assertSucceeded,
	SearchIndexError,
} from '../errors/search-index-error';
import { diffSettings } from './settings-diff';

export interface SyncOptions {
	/**
	 * Compare and report, but send nothing: no index is created, no setting
	 * updated. For a check in CI, or a look before a deploy.
	 */
	dryRun?: boolean;
	/** How long to wait for each task, and how often to ask. The SDK's. */
	wait?: WaitOptions;
}

/** What `sync` found and did to one index. */
export interface SyncReport {
	uid: string;
	/** The index did not exist, and was created with its primary key. */
	created: boolean;
	/** The index existed with no primary key, and was given the definition's. */
	primaryKeySet: boolean;
	/** The settings that differed from the definition, and were updated. */
	changed: (keyof Settings)[];
	/** The settings update that was sent, or would be in a dry run: `{}` for none. */
	update: Settings;
	/** The tasks this sync waited for, in order: none when nothing changed. */
	tasks: Task[];
	dryRun: boolean;
}

async function findIndex(
	client: Meilisearch,
	uid: string,
): Promise<IndexObject | undefined> {
	try {
		return await client.getRawIndex(uid);
	} catch (error) {
		if (
			error instanceof MeilisearchApiError &&
			error.cause?.code === 'index_not_found'
		) {
			return undefined;
		}
		throw error;
	}
}

/**
 * Brings one index in line with its definition, and says what it changed:
 *
 * 1. creates the index, with its primary key, when it is missing;
 * 2. gives it the primary key when it has none yet, and throws a
 *    `SearchIndexError` (`PRIMARY_KEY_MISMATCH`) when it has another;
 * 3. reads its settings and updates, in one task, only those that differ.
 *
 * It waits for every task it sends, and throws a `SearchIndexError`
 * (`TASK_FAILED`) for one that fails. Run it twice and the second run sends
 * nothing.
 */
export async function syncIndex(
	client: Meilisearch,
	definition: AnyIndexDefinition,
	options: SyncOptions = {},
): Promise<SyncReport> {
	const { uid, primaryKey } = definition;
	const dryRun = options.dryRun ?? false;
	const tasks: Task[] = [];
	const wait = async (enqueued: ReturnType<Meilisearch['createIndex']>) => {
		const task = await enqueued.waitTask(options.wait);
		tasks.push(task);
		return task;
	};

	let created = false;
	let primaryKeySet = false;
	let existing = await findIndex(client, uid);

	if (!existing) {
		created = true;
		if (!dryRun) {
			const task = await wait(client.createIndex(uid, { primaryKey }));
			// Created by someone else between the lookup and the creation: go on
			// with theirs, whose primary key is checked below.
			if (task.error?.code === 'index_already_exists') {
				created = false;
				tasks.pop();
				existing = await findIndex(client, uid);
			} else {
				assertSucceeded(task, uid);
			}
		}
	}

	if (existing) {
		const actual = existing.primaryKey ?? undefined;
		if (actual === undefined) {
			primaryKeySet = true;
			if (!dryRun) {
				assertSucceeded(
					await wait(client.updateIndex(uid, { primaryKey })),
					uid,
				);
			}
		} else if (actual !== primaryKey) {
			throw new SearchIndexError(
				`Index "${uid}" has the primary key "${actual}", but its definition ` +
					`says "${primaryKey}". Meilisearch cannot change the primary key of ` +
					'an index that holds documents: delete the index and sync again, ' +
					'or change the definition.',
				{
					code: 'PRIMARY_KEY_MISMATCH',
					indexUid: uid,
					expectedPrimaryKey: primaryKey,
					actualPrimaryKey: actual,
				},
			);
		}
	}

	const wanted = (definition.settings ?? {}) as Settings;
	// A missing index, in a dry run, has no settings to read: everything the
	// definition sets would be sent.
	const live: Settings =
		dryRun && created ? {} : await client.index(uid).getSettings();
	const update = diffSettings(wanted, live);
	const changed = Object.keys(update) as (keyof Settings)[];

	if (changed.length > 0 && !dryRun) {
		assertSucceeded(await wait(client.index(uid).updateSettings(update)), uid);
	}

	return { uid, created, primaryKeySet, changed, update, tasks, dryRun };
}

/**
 * `syncIndex` for each definition, one after the other, in the order given.
 * The first that throws stops the rest.
 */
export async function syncIndexes(
	client: Meilisearch,
	definitions: readonly AnyIndexDefinition[],
	options: SyncOptions = {},
): Promise<SyncReport[]> {
	const reports: SyncReport[] = [];
	for (const definition of definitions) {
		reports.push(await syncIndex(client, definition, options));
	}
	return reports;
}
