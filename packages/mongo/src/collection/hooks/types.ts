import type { ClientSession, Filter } from 'mongodb';
import type {
	DocumentOf,
	IdOf,
	ReadDocumentOf,
} from '../../definition/define-collection';
import type { NewDocumentOf } from '../../definition/writable';
import type {
	ActorOf,
	FilterOf,
	IfStamp,
	ManyPatch,
	Patch,
	TypedCollection,
	UpsertOf,
} from '../types';

/** The write a hook is running for. */
export type WriteOperation =
	| 'create'
	| 'createMany'
	| 'update'
	| 'updateMany'
	| 'upsert'
	| 'delete'
	| 'hardDelete'
	| 'deleteMany'
	| 'hardDeleteMany'
	| 'restore';

/** What every hook is told about the write it runs for. */
export interface HookContext<Def> {
	readonly operation: WriteOperation;
	/**
	 * The collection the write runs on, bound to the same session and actor.
	 * A hook that writes elsewhere through it — `collection.db`, or another
	 * collection with `withSession(context.session)` — stays in the
	 * transaction. Writing to *this* collection through it runs its hooks
	 * again.
	 */
	readonly collection: TypedCollection<Def>;
	readonly session: ClientSession | undefined;
	/** Who is writing, as `as(actor)` set it. */
	readonly actor: ActorOf<Def> | undefined;
}

/** A delete's context: whether the document goes for good. */
export interface DeleteHookContext<Def> extends HookContext<Def> {
	/**
	 * `true` for `hardDelete`, `hardDeleteMany`, and a `delete` on a
	 * collection that does not soft delete.
	 */
	readonly hard: boolean;
}

/** What `create` writes, and `createMany` writes once per document. */
export interface CreateArgs<Def> {
	values: NewDocumentOf<Def>;
}

/** What `upsert` matches on, and what it writes. */
export interface UpsertArgs<Def> {
	filter: FilterOf<Def>;
	values: UpsertOf<Def>;
}

export interface UpdateArgs<Def> {
	id: IdOf<Def>;
	patch: Patch<Def>;
}

export interface UpdateManyArgs<Def> {
	filter: Filter<DocumentOf<Def>>;
	patch: ManyPatch<Def>;
}

export interface DeleteArgs<Def> {
	id: IdOf<Def>;
}

export interface DeleteManyArgs<Def> {
	filter: Filter<DocumentOf<Def>>;
}

type Awaitable<T> = T | Promise<T>;

/**
 * Runs before the write, with what it is about to write. Returning a value of
 * the same shape replaces it — a filled field, a narrower filter; returning
 * nothing keeps it. Throwing stops the write.
 *
 * A misspelt field in the returned object is **not** a compile error:
 * TypeScript does not check a returned literal for extra properties, and the
 * schema then drops the field when it parses the write. Measured with every
 * form of this return type; none restores the check.
 */
export type BeforeHook<Args, Context> = (
	args: Args,
	context: Context,
	// `undefined` alone accepts an inline hook with no `return`, but refuses
	// one declared elsewhere and passed by name — measured — which is how a
	// hook shared between collections is written.
	// biome-ignore lint/suspicious/noConfusingVoidType: see above
) => Awaitable<Args | undefined | void>;

/**
 * Runs after the write, with what it gave back, and the arguments it was
 * written with alongside the context. The write has happened: throwing
 * rejects the call but undoes nothing, unless it ran in a transaction.
 */
export type AfterHook<Result, Args, Context> = (
	result: Result,
	context: Context & Args,
	// What it answers is ignored, so an expression body that returns the
	// driver's own promise — an audit `insertOne` — is accepted as it is.
) => unknown;

/**
 * Hooks around this package's writes, typed by the collection's schema.
 *
 * `createMany` runs `beforeCreate` and `afterCreate` once per document, so a
 * rule written for one document holds for a batch. A delete runs the delete
 * hooks whether it is soft or hard, and says which in `context.hard`.
 *
 * Reads, and the driver's own methods, run no hooks.
 */
export interface CollectionHooks<Def> {
	beforeCreate?: BeforeHook<CreateArgs<Def>, HookContext<Def>>;
	afterCreate?: AfterHook<
		ReadDocumentOf<Def>,
		CreateArgs<Def>,
		HookContext<Def>
	>;

	/**
	 * The one hook an upsert runs before it writes. There is no
	 * `beforeCreate`/`beforeUpdate` pair here: an upsert is one atomic
	 * operation, so which half will run is not known until the server has
	 * run it. Afterwards it **is** known, and `afterCreate` or `afterUpdate`
	 * runs accordingly, with `context.operation` still `'upsert'`.
	 */
	beforeUpsert?: BeforeHook<UpsertArgs<Def>, HookContext<Def>>;

	beforeUpdate?: BeforeHook<UpdateArgs<Def>, HookContext<Def>>;
	afterUpdate?: AfterHook<
		ReadDocumentOf<Def>,
		UpdateArgs<Def>,
		HookContext<Def>
	>;

	beforeUpdateMany?: BeforeHook<UpdateManyArgs<Def>, HookContext<Def>>;
	/** With the number of documents that changed. */
	afterUpdateMany?: AfterHook<number, UpdateManyArgs<Def>, HookContext<Def>>;

	beforeDelete?: BeforeHook<DeleteArgs<Def>, DeleteHookContext<Def>>;
	afterDelete?: AfterHook<
		ReadDocumentOf<Def>,
		DeleteArgs<Def>,
		DeleteHookContext<Def>
	>;

	beforeDeleteMany?: BeforeHook<DeleteManyArgs<Def>, DeleteHookContext<Def>>;
	/** With the number of documents deleted. */
	afterDeleteMany?: AfterHook<
		number,
		DeleteManyArgs<Def>,
		DeleteHookContext<Def>
	>;

	/** Only on a collection that soft deletes: there is nothing to restore otherwise. */
	beforeRestore?: IfStamp<
		Def,
		'deletedAt',
		BeforeHook<DeleteArgs<Def>, HookContext<Def>>,
		never
	>;
	afterRestore?: IfStamp<
		Def,
		'deletedAt',
		AfterHook<ReadDocumentOf<Def>, DeleteArgs<Def>, HookContext<Def>>,
		never
	>;
}
