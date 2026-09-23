import type { Meilisearch, Task, WaitOptions } from 'meilisearch';
import type { AnyIndexDefinition } from '../definition/define-index';
import {
	assertSucceeded,
	SearchIndexError,
} from '../errors/search-index-error';
import type { TypedIndex } from '../index/bind-index';
import { findIndex, type SyncReport, syncIndex } from './sync-index';

export interface RebuildOptions {
	/** The uid of the index filled beside the live one: `<uid>_next` by default. */
	nextUid?: string;
	/** How long to wait for each task, and how often to ask. The SDK's. */
	wait?: WaitOptions;
}

/** What `rebuild` did. */
export interface RebuildReport {
	uid: string;
	nextUid: string;
	/** An index under `nextUid`, left by a run that did not finish, was deleted first. */
	leftoverDeleted: boolean;
	/**
	 * The live index did not exist: the next one was renamed to its uid, and
	 * there was nothing to delete.
	 */
	created: boolean;
	/** The sync that created the next index with the definition's settings. */
	sync: SyncReport;
	/** The swap, or the rename, then the deletion of the previous index. */
	tasks: Task[];
}

/** What fills the next index, handed the typed index bound to it. */
export type RebuildFill<Def extends AnyIndexDefinition> = (
	next: TypedIndex<Def>,
) => Promise<void>;

/**
 * Where a rebuild stopped. `unknown` is the one case where the swap was sent
 * and could not be waited for: it may have happened, so nothing is deleted.
 */
type Stop = 'filling' | 'swapping' | 'unknown';

function stopped(uid: string, nextUid: string, stop: Stop, cause: unknown) {
	const message =
		stop === 'unknown'
			? `Rebuild of index "${uid}" sent the swap with "${nextUid}" and could not wait for it: ` +
				`whether "${uid}" was swapped is unknown, and "${nextUid}" was left for the next rebuild to delete.`
			: `Rebuild of index "${uid}" stopped while ${stop} "${nextUid}": ` +
				`"${nextUid}" was deleted, and "${uid}" is as it was.`;
	return new SearchIndexError(`${message} The cause is on \`cause\`.`, {
		code: 'REBUILD_FAILED',
		indexUid: uid,
		task: cause instanceof SearchIndexError ? cause.task : undefined,
		cause,
	});
}

async function deleteIndex(
	client: Meilisearch,
	uid: string,
	wait: WaitOptions | undefined,
): Promise<Task> {
	return assertSucceeded(await client.deleteIndex(uid).waitTask(wait), uid);
}

/**
 * Waits for every task `fill` left on the next index, including those it
 * only enqueued, and throws `TASK_FAILED` for the newest one that failed
 * since the index was created: the SDK resolves a failed task like a
 * succeeded one, and a failed write would otherwise be swapped in.
 */
async function settle(
	client: Meilisearch,
	nextUid: string,
	since: number,
	wait: WaitOptions | undefined,
): Promise<void> {
	for (;;) {
		const { results } = await client.tasks.getTasks({
			indexUids: [nextUid],
			statuses: ['enqueued', 'processing'],
			limit: 1000,
		});
		if (results.length === 0) break;
		await client.tasks.waitForTasks(
			results.map((task) => task.uid),
			wait,
		);
	}
	const { results } = await client.tasks.getTasks({
		indexUids: [nextUid],
		statuses: ['failed', 'canceled'],
		limit: 1,
	});
	const [newest] = results;
	if (newest && newest.uid > since) assertSucceeded(newest, nextUid);
}

/**
 * Sends the swap: with the live index when it exists, which is atomic on the
 * server, and as a rename when it does not — measured on v1.53.2, a swap with
 * a missing index fails `index_not_found`, whatever `rename` says, unless
 * `rename` is set and the existing index comes first.
 */
async function sendSwap(client: Meilisearch, uid: string, nextUid: string) {
	const created = (await findIndex(client, uid)) === undefined;
	const enqueued = await client.swapIndexes([
		created
			? { indexes: [nextUid, uid], rename: true }
			: { indexes: [uid, nextUid], rename: false },
	]);
	return { created, taskUid: enqueued.taskUid };
}

/**
 * Rebuilds an index beside the live one, then swaps it in: searches see the
 * old documents until the swap, and the new ones after it, never half of
 * them. See `TypedIndex.rebuild`.
 */
export async function rebuildIndex<Def extends AnyIndexDefinition>(
	client: Meilisearch,
	definition: Def,
	open: (definition: Def) => TypedIndex<Def>,
	fill: RebuildFill<Def>,
	options: RebuildOptions = {},
): Promise<RebuildReport> {
	const { uid } = definition;
	const nextUid = options.nextUid ?? `${uid}_next`;
	const { wait } = options;
	if (nextUid === uid) {
		throw new TypeError(
			`rebuild on "${uid}": nextUid must differ from the index's own uid`,
		);
	}

	const leftoverDeleted = (await findIndex(client, nextUid)) !== undefined;
	if (leftoverDeleted) await deleteIndex(client, nextUid, wait);

	// The next index is the definition under another uid: the same primary
	// key and settings, applied by the same sync.
	const nextDefinition = { ...definition, uid: nextUid } as Def;
	const sync = await syncIndex(client, nextDefinition, { wait });
	const since = sync.tasks[0]?.uid ?? 0;

	let stop: Stop = 'filling';
	let swap: { created: boolean; taskUid: number };
	let task: Task;
	try {
		await fill(open(nextDefinition));
		await settle(client, nextUid, since, wait);
		stop = 'swapping';
		swap = await sendSwap(client, uid, nextUid);
		stop = 'unknown';
		task = await client.tasks.waitForTask(swap.taskUid, wait);
		stop = 'swapping';
		assertSucceeded(task, uid);
	} catch (error) {
		// The cleanup must not hide what stopped the rebuild: a failure to
		// delete leaves an index the next run deletes first.
		if (stop !== 'unknown') {
			await client
				.deleteIndex(nextUid)
				.waitTask(wait)
				.catch(() => undefined);
		}
		throw stopped(uid, nextUid, stop, error);
	}

	const tasks = [task];
	// After a swap, the next uid holds the previous documents.
	if (!swap.created) tasks.push(await deleteIndex(client, nextUid, wait));
	return {
		uid,
		nextUid,
		leftoverDeleted,
		created: swap.created,
		sync,
		tasks,
	};
}
