import type {
	ClientSession,
	Db,
	Collection as DriverCollection,
	Filter,
} from 'mongodb';
import type {
	DocumentOf,
	FieldOf,
	IdOf,
	NewDocumentOf,
	ReadDocumentOf,
} from '../definition/define-collection';
import type { CursorPage, Page, PageOptions } from '../pagination/page';
import type { SyncOptions, SyncReport } from '../sync/sync-collection';
import type {
	ChangeHandler,
	ChangeOptions,
	ChangeSubscription,
} from './changes/types';
import type { CollectionHooks } from './hooks/types';

export type OrderDirection = 'asc' | 'desc';

/**
 * A field of the documents, or a path into one. The tail of a path cannot be
 * checked — a schema says nothing about what is under an arbitrary key — but
 * its head must be a field, which is what catches a misspelt name.
 */
export type FieldPath<Def> = FieldOf<Def> | `${FieldOf<Def>}.${string}`;

/** The fields whose type is a number, for `$inc` and `$mul`. */
type NumericFieldsOf<Doc> = {
	[K in keyof Doc]: NonNullable<Doc[K]> extends number ? K : never;
}[keyof Doc] &
	string;

/** The fields whose type is an array, for `$push` and `$addToSet`. */
type ArrayFieldsOf<Doc> = {
	[K in keyof Doc]: NonNullable<Doc[K]> extends readonly unknown[] ? K : never;
}[keyof Doc] &
	string;

type ElementOf<T> =
	NonNullable<T> extends readonly (infer Element)[] ? Element : never;

/** A sort, keyed on the schema's fields. */
export type SortOf<Def> = {
	[Field in FieldPath<Def>]?: 1 | -1 | 'asc' | 'desc';
};

/** What a projection may hold beside `0` and `1`. */
export type ProjectionOperator =
	| { $slice: number | [number, number] }
	| { $elemMatch: Record<string, unknown> }
	| { $meta: string };

/**
 * A projection, keyed on the schema's fields. It says what is sent over the
 * wire; it does not narrow the type of the documents, because the driver
 * cannot either — a projected read is typed as the whole document.
 */
export type ProjectionOf<Def> = {
	[Field in FieldPath<Def>]?: 0 | 1 | boolean | ProjectionOperator;
};

/** The actor's type under one name, or `never` when there is no such field. */
type ActorUnder<Doc, Name> = Name extends keyof Doc
	? NonNullable<Doc[Name]>
	: never;

/**
 * Who is writing: the type the schema gives the first actor field there is.
 *
 * It reads the names off the definition rather than spelling `'createdBy'`,
 * because the option may have renamed the field. Looking for the default name
 * made `actors: { createdBy: 'openedBy' }` resolve to `never`, which quietly
 * made `as()` uncallable on a collection that has an actor.
 *
 * A collection with none of the three has no actor to stamp, and `as` cannot
 * be called on it at all.
 */
export type ActorOf<Def> = Def extends {
	stamps: { createdBy: infer C; updatedBy: infer U; deletedBy: infer D };
}
	? [ActorUnder<DocumentOf<Def>, C>] extends [never]
		? [ActorUnder<DocumentOf<Def>, U>] extends [never]
			? ActorUnder<DocumentOf<Def>, D>
			: ActorUnder<DocumentOf<Def>, U>
		: ActorUnder<DocumentOf<Def>, C>
	: never;

/** What `$set` takes: a field's own type, or anything under a path. */
export type SetOf<Def> = {
	[Field in FieldPath<Def>]?: Field extends keyof DocumentOf<Def>
		? DocumentOf<Def>[Field]
		: unknown;
};

/**
 * MongoDB's update operators, keyed on the schema.
 *
 * The driver's own `UpdateFilter` is intersected with `Document`, whose index
 * signature accepts every key — `$set: { nope: 1 }` included — and `Omit`
 * cannot take that back, since omitting a literal key from an index signature
 * leaves the index signature. So the operators are declared here instead. One
 * this does not name is a reason to reach for `raw`, which is the driver's own
 * collection, untouched.
 */
export interface UpdateOperators<Def> {
	$set?: SetOf<Def>;
	$setOnInsert?: SetOf<Def>;
	$unset?: { [Field in FieldPath<Def>]?: '' | 1 | true };
	$inc?: {
		[Field in
			| NumericFieldsOf<DocumentOf<Def>>
			| `${FieldOf<Def>}.${string}`]?: number;
	};
	$mul?: {
		[Field in
			| NumericFieldsOf<DocumentOf<Def>>
			| `${FieldOf<Def>}.${string}`]?: number;
	};
	$min?: SetOf<Def>;
	$max?: SetOf<Def>;
	$rename?: { [Field in FieldPath<Def>]?: string };
	$currentDate?: {
		[Field in FieldPath<Def>]?: true | { $type: 'date' | 'timestamp' };
	};
	$push?: PushOf<Def>;
	$addToSet?: PushOf<Def>;
	$pull?: { [Field in FieldPath<Def>]?: unknown };
	$pullAll?: { [Field in FieldPath<Def>]?: readonly unknown[] };
	$pop?: { [Field in FieldPath<Def>]?: 1 | -1 };
}

/** What `$push` and `$addToSet` take: an element of the array, or `$each`. */
export type PushOf<Def> = {
	[Field in ArrayFieldsOf<DocumentOf<Def>>]?:
		| ElementOf<DocumentOf<Def>[Field]>
		| {
				$each: readonly ElementOf<DocumentOf<Def>[Field]>[];
				$position?: number;
				$slice?: number;
				$sort?: 1 | -1 | Record<string, 1 | -1>;
		  };
	// An index signature cannot be optional, so the paths are a mapped type.
} & { [Path in `${string}.${string}`]?: unknown };

/**
 * What an update writes: the document's own fields, checked against the
 * schema, or MongoDB's operators for what they cannot say.
 */
export type Patch<Def> =
	| Partial<DocumentOf<Def>>
	// Forbidding the document's own fields on this branch is what makes a
	// mistyped patch fail both of them rather than falling through to this one.
	| (UpdateOperators<Def> & {
			[K in keyof DocumentOf<Def>]?: never;
	  } & {
			// `id` is computed from `_id` and stored nowhere, so writing it is
			// always a mistake — one this branch would otherwise wave through,
			// since it is no field of the document.
			id?: never;
	  });

export interface ReadOptions {
	/** Include soft-deleted documents. Ignored without a `deletedAt` field. */
	withDeleted?: boolean;
}

export interface FindFirstOptions<Def> extends ReadOptions {
	sort?: SortOf<Def>;
	projection?: ProjectionOf<Def>;
}

export interface FindManyOptions<Def> extends FindFirstOptions<Def> {
	filter?: Filter<DocumentOf<Def>>;
	limit?: number;
	skip?: number;
}

export interface PaginateOptions<Def> extends PageOptions, ReadOptions {
	filter?: Filter<DocumentOf<Def>>;
	/** Default `{ _id: 1 }`, so that pages are stable. */
	sort?: SortOf<Def>;
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
 * `Yes` when the definition keeps that stamp, `No` when it has none.
 *
 * It reads the literal names `defineCollection` put on the definition. A
 * definition typed loosely — `AnyCollectionDefinition`, or `never` inside this
 * package — has `string | false` there, and gets `Yes`: only a definition that
 * is known to lack the stamp is refused.
 */
export type IfStamp<Def, Kind extends string, Yes, No> = [Def] extends [never]
	? Yes
	: [
				Def extends { stamps: { [K in Kind]: infer Name } } ? Name : string,
			] extends [false]
		? No
		: Yes;

export interface UpdateOptions<Def = unknown> {
	/**
	 * Only update the document while its version is still this one. When it
	 * is not, nothing is written and `OptimisticLockError` is thrown with the
	 * version the document has now. A collection with no version field does
	 * not take it.
	 */
	expectedVersion?: IfStamp<Def, 'version', number, never>;
}

export interface CollectionOptions<Def> {
	/**
	 * Soft delete through the soft-delete field. Default: on when the
	 * collection has one. `false` makes `delete` a real delete; a collection
	 * with no such field takes `false` only.
	 */
	softDelete?: IfStamp<Def, 'deletedAt', boolean, false>;
	/**
	 * Set the updated stamp on every update that does not set it. Default: on
	 * when the collection has one; a collection without takes `false` only.
	 */
	touchUpdatedAt?: IfStamp<Def, 'updatedAt', boolean, false>;
	/**
	 * Raise the version by one on every update. Default: on when the
	 * collection has a version field; one without takes `false` only.
	 * `expectedVersion` needs it.
	 */
	optimisticLock?: IfStamp<Def, 'version', boolean, false>;
	/**
	 * Check documents against the schema before writing them, which is also
	 * what fills their defaults. Default `'parse'`. `'off'` sends them as they
	 * are — and then nothing fills `_id`, `createdAt` or `version`.
	 */
	validate?: 'parse' | 'off';
	/** The largest `pageSize` or `limit` a page may ask for. Default `100`. */
	maxPageSize?: number;
	/** The session every operation runs in. `withSession` is how it is set. */
	session?: ClientSession;
	/** Who is writing, stamped into `createdBy`, `updatedBy` and `deletedBy`. */
	actor?: ActorOf<Def>;
	/** Which database, when `getCollection` is given a client rather than a `Db`. */
	db?: string;
	/**
	 * Sync the collection before the first operation, once per database.
	 *
	 * For tests and for development, where waiting on a deployment step is the
	 * thing in the way. It is **not** for production: `collMod` needs the
	 * `dbAdmin` role, and neither it nor an index build may run in a
	 * transaction. Use `syncAll` as a deployment step there.
	 *
	 * Only this package's own methods wait for it. `raw` and the driver's own
	 * methods are the escape hatch, and the escape hatch is not managed.
	 */
	autoSync?: boolean;
	/**
	 * Hooks around the writes, typed by the schema. An array runs each set in
	 * order — one for auditing, one for a tenant — with every `before` seeing
	 * what the previous one returned.
	 *
	 * `withSession` and `as` keep them.
	 */
	hooks?: CollectionHooks<Def> | readonly CollectionHooks<Def>[];
}

/**
 * What this package adds to a collection. The collection you are handed is
 * this **and** the driver's own `Collection`, so `aggregate`, `watch`,
 * `bulkWrite` and the rest are on it directly.
 */
export interface CollectionApi<Def> {
	readonly definition: Def;
	readonly db: Db;
	/**
	 * The driver's collection, untouched. It is where the three methods this
	 * one redefines still live — `raw.updateMany`, `raw.deleteMany` and
	 * `raw.count` — and where an update operator this package does not name
	 * can still be sent.
	 */
	readonly raw: DriverCollection<DocumentOf<Def>>;
	/** The session every operation of this collection runs in, if any. */
	readonly session: ClientSession | undefined;

	/**
	 * The same collection, bound to a session. MongoDB has no ambient session:
	 * without this, an operation inside a transaction runs outside it.
	 *
	 * It binds **this package's** methods. A driver method reached through the
	 * collection takes its session the driver's way, in its options.
	 */
	withSession(session: ClientSession | undefined): TypedCollection<Def>;
	/** The same collection, stamping this actor into the `*By` fields. */
	as(actor: ActorOf<Def>): TypedCollection<Def>;
	/** Creates the collection, its validator and its indexes. See `syncCollection`. */
	sync(options?: SyncOptions): Promise<SyncReport>;

	/** The document with this `_id`, or `undefined`. */
	findById(
		id: IdOf<Def>,
		options?: ReadOptions,
	): Promise<ReadDocumentOf<Def> | undefined>;
	/** The document with this `_id`. Throws `NotFoundError`. */
	getById(id: IdOf<Def>, options?: ReadOptions): Promise<ReadDocumentOf<Def>>;
	/** The first document that matches, or `undefined`. */
	findFirst(
		filter?: Filter<DocumentOf<Def>>,
		options?: FindFirstOptions<Def>,
	): Promise<ReadDocumentOf<Def> | undefined>;
	/** Every document that matches. */
	findMany(options?: FindManyOptions<Def>): Promise<ReadDocumentOf<Def>[]>;

	/** Checks the document against the schema, fills its defaults, inserts it. */
	create(values: NewDocumentOf<Def>): Promise<ReadDocumentOf<Def>>;
	/** The same, in one insert. `[]` sends nothing. */
	createMany(
		values: readonly NewDocumentOf<Def>[],
	): Promise<ReadDocumentOf<Def>[]>;
	/** Updates the document with this `_id` and returns it. Throws `NotFoundError`. */
	update(
		id: IdOf<Def>,
		patch: Patch<Def>,
		options?: UpdateOptions<Def>,
	): Promise<ReadDocumentOf<Def>>;
	/**
	 * Updates every document that matches, and returns how many changed. The
	 * driver's own `updateMany`, which returns an `UpdateResult` and takes no
	 * filter for granted, is `raw.updateMany`.
	 */
	updateMany(
		filter: Filter<DocumentOf<Def>>,
		patch: Patch<Def>,
	): Promise<number>;
	/**
	 * Deletes the document with this `_id` and returns it: a soft delete on a
	 * collection with `deletedAt`. Throws `NotFoundError`.
	 */
	delete(id: IdOf<Def>): Promise<ReadDocumentOf<Def>>;
	/** Deletes every document that matches, and returns how many. `raw.deleteMany` is the driver's. */
	deleteMany(filter: Filter<DocumentOf<Def>>): Promise<number>;
	/** A real delete, of a live or a soft-deleted document. */
	hardDelete(id: IdOf<Def>): Promise<ReadDocumentOf<Def>>;
	/** A real delete of every document that matches, soft-deleted ones included. */
	hardDeleteMany(filter: Filter<DocumentOf<Def>>): Promise<number>;
	/**
	 * Clears the soft-delete field and returns the document. Throws
	 * `NotFoundError`. A collection with no soft delete has nothing to restore,
	 * and the method cannot be called on it.
	 */
	restore: IfStamp<
		Def,
		'deletedAt',
		(id: IdOf<Def>) => Promise<ReadDocumentOf<Def>>,
		never
	>;

	/**
	 * Listens to the changes of this collection until `close()`, typed by its
	 * schema: `create`, `update`, `delete` — soft or hard — and `restore`.
	 *
	 * ```ts
	 * const subscription = users.onChange(async (change) => {
	 * 	if (change.type === 'create') await welcome(change.document.email);
	 * }, { events: ['create'] });
	 * await subscription.ready;
	 * ```
	 *
	 * It needs a replica set or a sharded cluster, as every change stream does.
	 */
	onChange(
		handler: ChangeHandler<Def>,
		options?: ChangeOptions<Def>,
	): ChangeSubscription;

	/**
	 * How many documents match, soft-deleted ones left out. The driver's
	 * `count` is `raw.count`, and `estimatedDocumentCount` is on this
	 * collection directly.
	 */
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
	paginate(options?: PaginateOptions<Def>): Promise<Page<ReadDocumentOf<Def>>>;
	/** One page of the documents that match, after a cursor. */
	paginateByCursor(
		options?: CursorPaginateOptions<Def>,
	): Promise<CursorPage<ReadDocumentOf<Def>>>;
}

/**
 * A collection: this package's methods, plus every method of the driver's own
 * `Collection` that they do not redefine.
 *
 * Three names are defined by both, and this package's win: `count`,
 * `updateMany` and `deleteMany`. The driver's are on `raw`.
 */
export type TypedCollection<Def> = CollectionApi<Def> &
	Omit<DriverCollection<DocumentOf<Def>>, keyof CollectionApi<Def>>;
