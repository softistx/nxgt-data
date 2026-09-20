/** What stopped a sync, as a string to switch on. */
export type SearchSyncErrorCode =
	/** The transform gave a document whose primary key is not its index id. */
	| 'ID_MISMATCH'
	/** The transform gave something that is neither a document nor `null`. */
	| 'NOT_A_DOCUMENT'
	/** Anything else: the cause says what. */
	| 'FAILED';

export interface SearchSyncErrorOptions {
	code: SearchSyncErrorCode;
	sync: string;
	cause?: unknown;
}

/** An error of a sync, with the sync's name and what caused it. */
export class SearchSyncError extends Error {
	override name = 'SearchSyncError';
	readonly code: SearchSyncErrorCode;
	/** The sync's name. */
	readonly sync: string;

	constructor(message: string, options: SearchSyncErrorOptions) {
		super(
			message,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.code = options.code;
		this.sync = options.sync;
	}
}

/** `error` as a `SearchSyncError`, kept as it is when it already is one. */
export function failed(sync: string, doing: string, error: unknown) {
	if (error instanceof SearchSyncError) return error;
	const reason = error instanceof Error ? error.message : String(error);
	return new SearchSyncError(
		`Search sync "${sync}" failed ${doing}: ${reason}`,
		{
			code: 'FAILED',
			sync,
			cause: error,
		},
	);
}
