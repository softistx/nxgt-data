import type { IndexSwap, Meilisearch, Task, WaitOptions } from 'meilisearch';
import type { AnyIndexDefinition } from '../definition/define-index';
import { INDEX_UID_SHAPE, isIndexUid } from '../definition/uid';
import {
	assertSucceeded,
	SearchIndexError,
} from '../errors/search-index-error';
import type { TypedIndex } from '../index/bind-index';
import { findIndex, type SyncReport, syncIndexFor } from './sync-index';

export interface RebuildOptions {
	/**
	 * The uid of the index filled beside the live one: `<uid>_next` by
	 * default, which is refused for a uid over 395 characters — pass a shorter
	 * one then.
	 */
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

/**
 * The definition of the next index: the live one's, under another uid. The
 * uid is widened to `string` — typed as the live uid, it would let a caller
 * key a tenant token's rule by a uid the index does not have.
 */
export type RebuildDefinition<Def extends AnyIndexDefinition> = Omit<
	Def,
	'uid'
> & { readonly uid: string };

/** What fills the next index, handed the typed index bound to it. */
export type RebuildFill<Def extends AnyIndexDefinition> = (
	next: TypedIndex<RebuildDefinition<Def>>,
) => Promise<void>;

/**
 * Where a rebuild stopped. `unknown` is from the moment the swap request is
 * sent until its task is read back: a lost response or a failed wait may
 * hide a swap that happened, so nothing is deleted.
 */
type Stop = 'creating' | 'filling' | 'swapping' | 'unknown';

function stopped(
	uid: string,
	nextUid: string,
	stop: Stop,
	deleted: boolean,
	cause: unknown,
) {
	const left = deleted
		? `"${nextUid}" was deleted`
		: `"${nextUid}" could not be deleted; the next rebuild deletes it first`;
	const message =
		stop === 'unknown'
			? `Rebuild of index "${uid}" sent the swap with "${nextUid}" and could not wait for it: ` +
				`whether "${uid}" was swapped is unknown, and "${nextUid}" was left for the next rebuild to delete.`
			: `Rebuild of index "${uid}" stopped while ${stop} "${nextUid}": ` +
				`${left}, and "${uid}" is as it was.`;
	return new SearchIndexError(`${message} The cause is on \`cause\`.`, {
		code: 'REBUILD_FAILED',
		indexUid: uid,
		task: cause instanceof SearchIndexError ? cause.task : undefined,
		cause,
	});
}

/**
 * Deletes the next index after a rebuild stopped, and says whether it is
 * gone. It never throws: what stopped the rebuild is the error to report.
 * An index that is not there is gone: when its creation was the refused
 * step, the deletion task fails `index_not_found`, and nothing is left.
 */
async function discard(
	client: Meilisearch,
	nextUid: string,
	wait: WaitOptions | undefined,
): Promise<boolean> {
	try {
		await deleteIndex(client, nextUid, wait);
		return true;
	} catch (error) {
		return (
			error instanceof SearchIndexError &&
			error.task?.error?.code === 'index_not_found'
		);
	}
}

async function deleteIndex(
	client: Meilisearch,
	uid: string,
	wait: WaitOptions | undefined,
): Promise<Task> {
	return assertSucceeded(
		await client.deleteIndex(uid).waitTask(wait),
		uid,
		'rebuild',
	);
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
	if (newest && newest.uid > since) assertSucceeded(newest, nextUid, 'rebuild');
}

/**
 * The swap: with the live index when it exists, which is atomic on the
 * server, and as a rename when it does not — measured on v1.53.2, a swap with
 * a missing index fails `index_not_found`, whatever `rename` says, unless
 * `rename` is set and the existing index comes first.
 */
function swapOf(uid: string, nextUid: string, created: boolean): IndexSwap {
	return created
		? { indexes: [nextUid, uid], rename: true }
		: { indexes: [uid, nextUid], rename: false };
}

/**
 * Rebuilds an index beside the live one, then swaps it in: searches see the
 * old documents until the swap, and the new ones after it, never half of
 * them. See `TypedIndex.rebuild`.
 */
export async function rebuildIndex<Def extends AnyIndexDefinition>(
	client: Meilisearch,
	definition: Def,
	open: (
		definition: RebuildDefinition<Def>,
	) => TypedIndex<RebuildDefinition<Def>>,
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
	// Before any request: the server would refuse it on the first one, with
	// nothing to say which uid. `<uid>_next` is too long past 395 characters.
	if (!isIndexUid(nextUid)) {
		throw new TypeError(
			`rebuild on "${uid}": the next index's uid must be ${INDEX_UID_SHAPE}; ` +
				'a uid over 395 characters needs a shorter nextUid',
		);
	}

	const leftoverDeleted = (await findIndex(client, nextUid)) !== undefined;
	if (leftoverDeleted) await deleteIndex(client, nextUid, wait);

	// The next index is the definition under another uid: the same primary
	// key and settings, applied by the same sync.
	const nextDefinition = { ...definition, uid: nextUid };
	let stop: Stop = 'creating';
	let sync: SyncReport;
	let created: boolean;
	let task: Task;
	try {
		sync = await syncIndexFor(client, nextDefinition, { wait }, 'rebuild');
		stop = 'filling';
		await fill(open(nextDefinition));
		await settle(client, nextUid, sync.tasks[0]?.uid ?? 0, wait);
		stop = 'swapping';
		created = (await findIndex(client, uid)) === undefined;
		stop = 'unknown';
		const enqueued = await client.swapIndexes([swapOf(uid, nextUid, created)]);
		task = await client.tasks.waitForTask(enqueued.taskUid, wait);
		stop = 'swapping';
		assertSucceeded(task, uid, 'rebuild');
	} catch (error) {
		// The cleanup must not hide what stopped the rebuild: a failure to
		// delete leaves an index the next run deletes first, and says so.
		const deleted =
			stop !== 'unknown' && (await discard(client, nextUid, wait));
		throw stopped(uid, nextUid, stop, deleted, error);
	}

	const tasks = [task];
	// After a swap, the next uid holds the previous documents.
	if (!created) tasks.push(await deleteIndex(client, nextUid, wait));
	return { uid, nextUid, leftoverDeleted, created, sync, tasks };
}
