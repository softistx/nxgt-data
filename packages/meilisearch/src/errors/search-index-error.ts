import type { Task } from 'meilisearch';

/** What went wrong, as a string a caller can switch on. */
export type SearchIndexErrorCode = 'PRIMARY_KEY_MISMATCH' | 'TASK_FAILED';

export interface SearchIndexErrorOptions {
	code: SearchIndexErrorCode;
	indexUid: string;
	/** The task that failed or was canceled, for `TASK_FAILED`. */
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
 *   `canceled`; `task` is the task, and `cause` is its `error`.
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

/**
 * The task, if it succeeded. Otherwise a `SearchIndexError` with the task and
 * Meilisearch's message: the SDK resolves a failed task like a succeeded one.
 */
export function assertSucceeded(task: Task, indexUid: string): Task {
	if (task.status === 'succeeded') return task;
	const reason = task.error?.message ?? `it was ${task.status}`;
	throw new SearchIndexError(
		`Task ${task.uid} (${task.type}) on index "${indexUid}" ${task.status}: ${reason}`,
		{ code: 'TASK_FAILED', indexUid, task, cause: task.error ?? undefined },
	);
}
