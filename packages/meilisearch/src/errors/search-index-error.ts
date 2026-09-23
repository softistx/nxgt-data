import type { Task } from 'meilisearch';

/** What went wrong, as a string a caller can switch on. */
export type SearchIndexErrorCode =
	| 'PRIMARY_KEY_MISMATCH'
	| 'TASK_FAILED'
	| 'REBUILD_FAILED'
	| 'INVALID_EXPIRES_AT';

export interface SearchIndexErrorOptions {
	code: SearchIndexErrorCode;
	indexUid: string;
	/**
	 * The task that failed or was canceled, for `TASK_FAILED`, and for a
	 * `REBUILD_FAILED` that a task of the next index caused.
	 */
	task?: Task | undefined;
	/** The primary key the definition names, for `PRIMARY_KEY_MISMATCH`. */
	expectedPrimaryKey?: string | undefined;
	/** The primary key the index has, for `PRIMARY_KEY_MISMATCH`. */
	actualPrimaryKey?: string | undefined;
	cause?: unknown;
}

/**
 * The one error this package throws of its own. A request Meilisearch refuses
 * throws the SDK's `MeilisearchApiError`, as it would without this package.
 *
 * - `PRIMARY_KEY_MISMATCH`: `sync` found the index with another primary key.
 * - `TASK_FAILED`: a task this package waited for ended `failed` or
 *   `canceled`; `task` is the task, and `cause` is its `error`. The message
 *   names the call and Meilisearch's error code; the server's own sentence,
 *   which can quote a filter or a document id, is only on `cause`.
 * - `REBUILD_FAILED`: `rebuild` stopped before the swap, deleted the next
 *   index and left the live one as it was — or sent the swap and could not
 *   wait for it, and deleted nothing; `cause` is what stopped it.
 * - `INVALID_EXPIRES_AT`: `tenantToken` was given an `expiresAt` that is past,
 *   or not a time Meilisearch reads; nothing was signed. `indexUid` holds the
 *   token's uids, joined by `,`.
 */
export class SearchIndexError extends Error {
	override name = 'SearchIndexError';
	readonly code: SearchIndexErrorCode;
	readonly indexUid: string;
	readonly task: Task | undefined;
	readonly expectedPrimaryKey: string | undefined;
	readonly actualPrimaryKey: string | undefined;

	constructor(message: string, options: SearchIndexErrorOptions) {
		super(
			message,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.code = options.code;
		this.indexUid = options.indexUid;
		this.task = options.task;
		this.expectedPrimaryKey = options.expectedPrimaryKey;
		this.actualPrimaryKey = options.actualPrimaryKey;
	}
}

/** The calls that wait for a task, as a consumer writes them. */
export type TaskCall =
	| 'add'
	| 'addInBatches'
	| 'update'
	| 'updateInBatches'
	| 'delete'
	| 'deleteByFilter'
	| 'deleteAll'
	| 'sync'
	| 'rebuild';

/**
 * The task, if it succeeded. Otherwise a `SearchIndexError` with the task: the
 * SDK resolves a failed task like a succeeded one.
 *
 * `call` is the call a consumer wrote — `deleteByFilter`, not the task's
 * `documentDeletion`, which `delete` shares. The message holds the task's uid,
 * that call, the index and Meilisearch's error `code`, never its sentence:
 * the server quotes the filter a caller sent, or the document id it refused,
 * and a message reports a shape, never a value. The sentence stays on
 * `cause` and on `task.error`.
 */
export function assertSucceeded(
	task: Task,
	indexUid: string,
	call: TaskCall,
): Task {
	if (task.status === 'succeeded') return task;
	const code = task.error?.code;
	throw new SearchIndexError(
		`Task ${task.uid} (${call}) on index "${indexUid}" ${task.status}` +
			(code ? `: ${code}` : ''),
		{ code: 'TASK_FAILED', indexUid, task, cause: task.error ?? undefined },
	);
}
