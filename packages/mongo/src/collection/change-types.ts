import type { Filter } from 'mongodb';
import type {
	DocumentOf,
	IdOf,
	ReadDocumentOf,
} from '../definition/define-collection';
import type { IfStamp } from './types';

/**
 * What happened to a document, in this package's words rather than the
 * server's: a soft delete is a `delete`, not an `update` that set a date.
 */
export type ChangeType = 'create' | 'update' | 'delete' | 'restore';

interface ChangeBase<Def> {
	/** The document's `_id`. */
	readonly id: IdOf<Def>;
	/** When the server applied the change. */
	readonly at: Date;
	/**
	 * Where the stream is, just after this change. Opaque: pass it back as
	 * `startAfter` to pick up from here in another subscription.
	 */
	readonly resumeToken: unknown;
}

export interface CreateChange<Def> extends ChangeBase<Def> {
	readonly type: 'create';
	readonly document: ReadDocumentOf<Def>;
}

export interface UpdateChange<Def> extends ChangeBase<Def> {
	readonly type: 'update';
	/**
	 * The document after the change — or as it is now, when the collection
	 * keeps no post-images: a later write may already be in it. `undefined`
	 * when it has been deleted since.
	 */
	readonly document: ReadDocumentOf<Def> | undefined;
	/**
	 * The document before the change, when the collection keeps pre-images
	 * (`options.changeStreamPreAndPostImages`); `undefined` otherwise.
	 */
	readonly before: ReadDocumentOf<Def> | undefined;
	/**
	 * The fields the update set and removed. `undefined` for a replacement,
	 * which rewrites the whole document.
	 */
	readonly fields:
		| {
				readonly set: Partial<DocumentOf<Def>>;
				readonly removed: readonly string[];
		  }
		| undefined;
}

export interface DeleteChange<Def> extends ChangeBase<Def> {
	readonly type: 'delete';
	/**
	 * `false` for a soft delete — the document is still there, with its
	 * soft-delete field set — and `true` when it is gone.
	 */
	readonly hard: boolean;
	/** After a soft delete, the document as it now is; after a hard one, nothing. */
	readonly document: ReadDocumentOf<Def> | undefined;
	/** The document before, when the collection keeps pre-images. */
	readonly before: ReadDocumentOf<Def> | undefined;
}

export interface RestoreChange<Def> extends ChangeBase<Def> {
	readonly type: 'restore';
	readonly document: ReadDocumentOf<Def> | undefined;
	readonly before: ReadDocumentOf<Def> | undefined;
}

/** A change to a document of this collection. `restore` only where it soft deletes. */
export type ChangeOf<Def> =
	| CreateChange<Def>
	| UpdateChange<Def>
	| DeleteChange<Def>
	| IfStamp<Def, 'deletedAt', RestoreChange<Def>, never>;

/** Why a subscription stopped. */
export type CloseReason =
	/** `close()` was called. */
	| 'closed'
	/** The collection was dropped or renamed: the stream cannot go on. */
	| 'invalidated'
	/** An error stopped it, and `onError` was told. */
	| 'failed';

export interface ChangeOptions<Def> {
	/**
	 * Which changes to hear about. Default: all of them. The server is asked
	 * for the matching operations only; a soft delete and a restore are told
	 * apart from other updates here.
	 */
	events?: readonly IfStamp<
		Def,
		'deletedAt',
		ChangeType,
		Exclude<ChangeType, 'restore'>
	>[];
	/**
	 * Only changes to documents that match, checked against the document
	 * after the change. A hard delete has no document after it: it is matched
	 * against the one before when the collection keeps pre-images, and
	 * delivered whatever the filter says when it does not.
	 */
	filter?: Filter<DocumentOf<Def>>;
	/**
	 * Hear about updates to soft-deleted documents too. Default `false`, as
	 * for every read: the soft delete itself, and the restore, are always
	 * delivered.
	 */
	withDeleted?: IfStamp<Def, 'deletedAt', boolean, false>;
	/**
	 * Start just after this token — a change's `resumeToken`, or a
	 * subscription's — rather than now.
	 */
	startAfter?: unknown;
	/**
	 * What to do with an error: one the handler threw (the change is then
	 * skipped and the stream goes on), or one that stopped the stream for
	 * good. Without it, the first error closes the subscription and rejects
	 * `closed` — which, like an `error` event nobody listens to, ends the
	 * process when nothing awaits it.
	 */
	onError?: (error: unknown, change: ChangeOf<Def> | undefined) => unknown;
	/**
	 * How many times in a row to reopen the stream after an error the driver
	 * did not recover from itself. Default `5`, with a delay that doubles from
	 * 100 ms up to 10 s. A change delivered resets the count.
	 */
	retries?: number;
}

/** A running subscription. */
export interface ChangeSubscription extends AsyncDisposable {
	/**
	 * Resolves once the stream is open on the server: a change made after it
	 * is heard. One made before may not be.
	 */
	readonly ready: Promise<void>;
	/**
	 * Settles when the subscription stops: resolves with the reason on
	 * `close()`, when the collection is dropped, or on an error `onError` was
	 * told about; rejects with the error when there is no `onError`.
	 */
	readonly closed: Promise<CloseReason>;
	/** Where the stream is: the token of the last change handled, once there is one. */
	readonly resumeToken: unknown;
	/** Stops listening. A change being handled is finished first. */
	close(): Promise<void>;
}

/** What a subscription's handler is called with, and may wait on. */
export type ChangeHandler<Def> = (change: ChangeOf<Def>) => unknown;
