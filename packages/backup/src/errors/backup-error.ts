/** What went wrong, as a string a caller can switch on. */
export type BackupErrorCode =
	| 'NOT_FOUND'
	| 'INTEGRITY'
	| 'DECRYPT'
	| 'SIGNATURE'
	| 'PARTIAL'
	| 'NOT_STORED'
	| 'LOCKED'
	| 'LEASE_LOST';

/** How one repository took a backup: stored, or the error that stopped it. */
export type RepositoryOutcome =
	| { repository: string; stored: true }
	| { repository: string; stored: false; error: unknown };

export interface BackupErrorOptions {
	code: BackupErrorCode;
	/** The backup definition's name. */
	backup: string;
	/** The backup's id, once there is one. */
	id?: string | undefined;
	/** The repository the error is about, for `NOT_FOUND`, `INTEGRITY`, `DECRYPT`, `SIGNATURE`, `LOCKED`, `LEASE_LOST`. */
	repository?: string | undefined;
	/** Every repository's outcome, for `PARTIAL` and `NOT_STORED`. */
	outcomes?: readonly RepositoryOutcome[] | undefined;
	cause?: unknown;
}

/**
 * The one error this package throws of its own.
 *
 * - `NOT_FOUND`: no backup with that id in that repository — or one whose
 *   manifest was never written, which is the same thing: a backup exists
 *   once its manifest does.
 * - `INTEGRITY`: what the repository holds is not what the manifest says —
 *   a size or a SHA-256 that differs, a manifest or a catalog that does not
 *   parse, a decompressed entry whose digest differs. A manifest mismatch stops
 *   before a byte is decrypted; a catalog mismatch fails the entry's stream
 *   at its end, so a target that streams has already seen those bytes.
 * - `DECRYPT`: none of the identities given opens the backup.
 * - `SIGNATURE`: trusted keys are set, and the manifest is not signed, or
 *   not by any of them. Nothing else of the backup was read.
 * - `PARTIAL`: `create` stored the backup in some repositories and not in
 *   others; `outcomes` says which. The copies that were stored are complete
 *   and stay.
 * - `NOT_STORED`: `create` stored it nowhere; `outcomes` holds each error.
 * - `LOCKED`: another `create` or `prune` of the same definition holds the
 *   repository's lock. Try again later. In `create`, it is a repository's
 *   outcome, and the others go on.
 * - `LEASE_LOST`: this run's lock could not be renewed in time — the store
 *   out of reach, or the process paused longer than the lease — so it
 *   started nothing more there. Worth an alert, not just a retry. In
 *   `create`, a repository's outcome, without a manifest there.
 *
 * The message names the call, the definition and the repository, never an
 * entry's name, a key or anything read from a source.
 */
export class BackupError extends Error {
	override name = 'BackupError';
	readonly code: BackupErrorCode;
	readonly backup: string;
	readonly id: string | undefined;
	readonly repository: string | undefined;
	readonly outcomes: readonly RepositoryOutcome[];

	constructor(message: string, options: BackupErrorOptions) {
		super(
			message,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.code = options.code;
		this.backup = options.backup;
		this.id = options.id;
		this.repository = options.repository;
		this.outcomes = options.outcomes ?? [];
	}
}
