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
	| 'MALFORMED';

/**
 * What `@nxgt/mongo-backup` throws, told apart by `code`. Its message says
 * what went wrong and never quotes a value, a document or a name: a backup
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
