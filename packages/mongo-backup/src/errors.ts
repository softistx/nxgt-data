export type MongoBackupErrorCode =
	/** The snapshot outlived what the server keeps of its history. */
	| 'SNAPSHOT_TOO_OLD'
	/** The collections or their indexes kept changing while the snapshot was taken. */
	| 'CHANGING'
	/** The change stream cannot resume from the recorded position. */
	| 'HISTORY_LOST'
	/** The database holds something this version does not back up. */
	| 'UNSUPPORTED'
	/** A collection or view the restore would write is already there. */
	| 'EXISTS'
	/** An entry is not one this version wrote. */
	| 'MALFORMED'
	/** A collection a restore names is not in the backup, or no backup is there to restore. */
	| 'NOT_FOUND'
	/** The key file is not one `keygen` wrote, or others can read it. */
	| 'KEY_FILE';

/**
 * What `@nxgt/mongo-backup` throws, told apart by `code`. Its message says
 * what went wrong and never quotes a value, a document or a collection's
 * name — only the backup's own name, which the caller configured: a backup
 * error ends up in logs.
 */
export class MongoBackupError extends Error {
	override readonly name = 'MongoBackupError';
	readonly code: MongoBackupErrorCode;

	constructor(
		message: string,
		code: MongoBackupErrorCode,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.code = code;
	}
}

/**
 * The server's numeric error code, if `error` carries one. A command read
 * with `promoteValues: false` — a change stream that keeps number kinds —
 * gives it as a BSON `Int32`, not a number.
 */
export function serverCode(error: unknown): number | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	const value = (code as { valueOf?: () => unknown } | null)?.valueOf?.();
	return typeof value === 'number' ? value : undefined;
}

const BEHIND = /^mongo(Source|Target): /;

/**
 * `p`, its `mongoSource:` and `mongoTarget:` refusals told as `where` — the
 * call the consumer wrote — with the same class and code, the original as
 * `cause`. Any other error passes as it is.
 */
export function renamed<T>(p: Promise<T>, where: string): Promise<T> {
	return p.catch((error: unknown) => {
		if (!(error instanceof Error) || !BEHIND.test(error.message)) throw error;
		const message = error.message.replace(BEHIND, `${where}: `);
		throw error instanceof MongoBackupError
			? new MongoBackupError(message, error.code, { cause: error })
			: new TypeError(message, { cause: error });
	});
}
