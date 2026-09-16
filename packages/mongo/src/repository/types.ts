import type {
	ClientSession,
	Collection,
	Db,
	Filter,
	Sort,
	UpdateFilter,
} from 'mongodb';
import type {
	DocumentOf,
	FieldOf,
	IdOf,
	NewDocumentOf,
} from '../definition/define-collection';
import type { CursorPage, Page, PageOptions } from '../pagination/page';
import type { SyncOptions, SyncReport } from '../sync/sync-collection';

export type OrderDirection = 'asc' | 'desc';

export interface ReadOptions {
	/** Include soft-deleted documents. Ignored without a `deletedAt` field. */
	withDeleted?: boolean;
}

export interface FindFirstOptions<Def> extends ReadOptions {
	sort?: Sort;
	projection?: Record<FieldOf<Def>, 0 | 1> | Record<string, unknown>;
}

export interface FindManyOptions<Def> extends FindFirstOptions<Def> {
	filter?: Filter<DocumentOf<Def>>;
	limit?: number;
	skip?: number;
}

export interface PaginateOptions<Def> extends PageOptions, ReadOptions {
	filter?: Filter<DocumentOf<Def>>;
	/** Default `{ _id: 1 }`, so that pages are stable. */
	sort?: Sort;
}

export interface CursorPaginateOptions<Def> extends ReadOptions {
	/** The `nextCursor` of the previous page. Omit it for the first page. */
	after?: string | null | undefined;
	/** Documents per page. Default `20`, at most `maxPageSize`. */
	limit?: number;
	filter?: Filter<DocumentOf<Def>>;
	/**
	 * The field to page along. Default `_id`. Any other is followed by `_id`,
	 * which breaks its ties, and must be set on every document.
	 */
	orderBy?: FieldOf<Def>;
	/** Default `'asc'`. */
	direction?: OrderDirection;
}

/**
 * What an update writes: the document's own fields, checked against the
 * schema, or MongoDB's operators for anything they cannot say.
 *
 * The driver's `UpdateFilter` is intersected with `Document`, so it accepts
 * any key whatsoever; a plain patch is what gets checked.
 */
export type Patch<Def> =
	| Partial<DocumentOf<Def>>
	// `UpdateFilter` is intersected with `Document`, so on its own it accepts
	// any key at all — `{ email: 1 }` on a string field included. Forbidding
	// the document's own fields on this branch is what makes a mistyped patch
	// fail both of them.
	| (UpdateFilter<DocumentOf<Def>> & {
			[K in keyof DocumentOf<Def>]?: never;
	  });

export interface UpdateOptions {
	/**
	 * Only update the document while its `version` is still this one. When it
	 * is not, nothing is written and `OptimisticLockError` is thrown with the
	 * version the document has now.
	 */
	expectedVersion?: number;
}

export interface RepositoryOptions {
	/**
	 * Soft delete through the `deletedAt` field. Default: on when the schema
	 * has one. `false` makes `delete` a real delete.
	 */
	softDelete?: boolean;
	/**
	 * Set `updatedAt` on every update that does not set it. Default: on when
	 * the schema has the field.
	 */
	touchUpdatedAt?: boolean;
	/**
	 * Raise `version` by one on every update. Default: on when the schema has
	 * the field. `expectedVersion` needs it.
	 */
	optimisticLock?: boolean;
	/**
	 * Check documents against the schema before writing them, which is also
	 * what fills their defaults. Default `'parse'`. `'off'` sends them as they
	 * are — and then nothing fills `_id`, `createdAt` or `version`.
	 */
	validate?: 'parse' | 'off';
	/** The largest `pageSize` or `limit` a page may ask for. Default `100`. */
	maxPageSize?: number;
	/** The session every operation runs in. `with(session)` is how it is set. */
	session?: ClientSession;
	/** Who is writing, stamped into `createdBy`, `updatedBy` and `deletedBy`. */
	actor?: unknown;
}

/**
 * A repository over one collection: typed reads and writes by `_id` or by
 * filter, pagination, soft delete, optimistic locking, audit stamps, and
 * MongoDB errors turned into this package's.
 */
export interface Repository<Def> {
	readonly definition: Def;
	readonly db: Db;
	/** The driver's collection, for anything this does not wrap. */
	readonly collection: Collection<DocumentOf<Def> & Document>;
	/** The session every operation of this repository runs in, if any. */
	readonly session: ClientSession | undefined;

	/**
	 * The same repository, bound to a session. MongoDB has no ambient
	 * session: without this, an operation inside a transaction runs outside
	 * it.
	 */
	with(session: ClientSession | undefined): Repository<Def>;
	/** The same repository, stamping this actor into the `*By` fields. */
	as(actor: unknown): Repository<Def>;
	/** Creates the collection, its validator and its indexes. See `syncCollection`. */
	sync(options?: SyncOptions): Promise<SyncReport>;

	/** The document with this `_id`, or `undefined`. */
	findById(
		id: IdOf<Def>,
		options?: ReadOptions,
	): Promise<DocumentOf<Def> | undefined>;
	/** The document with this `_id`. Throws `NotFoundError`. */
	getById(id: IdOf<Def>, options?: ReadOptions): Promise<DocumentOf<Def>>;
	/** The first document that matches, or `undefined`. */
	findFirst(
		filter?: Filter<DocumentOf<Def>>,
		options?: FindFirstOptions<Def>,
	): Promise<DocumentOf<Def> | undefined>;
	/** Every document that matches. */
	findMany(options?: FindManyOptions<Def>): Promise<DocumentOf<Def>[]>;

	/** Checks the document against the schema, fills its defaults, inserts it. */
	create(values: NewDocumentOf<Def>): Promise<DocumentOf<Def>>;
	/** The same, in one insert. `[]` sends nothing. */
	createMany(values: readonly NewDocumentOf<Def>[]): Promise<DocumentOf<Def>[]>;
	/** Updates the document with this `_id` and returns it. Throws `NotFoundError`. */
	update(
		id: IdOf<Def>,
		patch: Patch<Def>,
		options?: UpdateOptions,
	): Promise<DocumentOf<Def>>;
	/** Updates every document that matches, and returns how many changed. */
	updateMany(
		filter: Filter<DocumentOf<Def>>,
		patch: Patch<Def>,
	): Promise<number>;
	/**
	 * Deletes the document with this `_id` and returns it: a soft delete on a
	 * collection with `deletedAt`. Throws `NotFoundError`.
	 */
	delete(id: IdOf<Def>): Promise<DocumentOf<Def>>;
	/** Deletes every document that matches, and returns how many. */
	deleteMany(filter: Filter<DocumentOf<Def>>): Promise<number>;
	/** A real delete, of a live or a soft-deleted document. */
	hardDelete(id: IdOf<Def>): Promise<DocumentOf<Def>>;
	/** A real delete of every document that matches, soft-deleted ones included. */
	hardDeleteMany(filter: Filter<DocumentOf<Def>>): Promise<number>;
	/** Clears `deletedAt` and returns the document. Throws `NotFoundError`. */
	restore(id: IdOf<Def>): Promise<DocumentOf<Def>>;

	/** How many documents match. */
	count(
		filter?: Filter<DocumentOf<Def>>,
		options?: ReadOptions,
	): Promise<number>;
	/** Whether any document matches. */
	exists(
		filter: Filter<DocumentOf<Def>>,
		options?: ReadOptions,
	): Promise<boolean>;
	/** One page of the documents that match, and how many there are. */
	paginate(options?: PaginateOptions<Def>): Promise<Page<DocumentOf<Def>>>;
	/** One page of the documents that match, after a cursor. */
	paginateByCursor(
		options?: CursorPaginateOptions<Def>,
	): Promise<CursorPage<DocumentOf<Def>>>;
}
