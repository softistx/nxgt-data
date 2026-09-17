import type { ClientSession, Db, MongoClient } from 'mongodb';
import type { z } from 'zod';
import type {
	AnyCollectionDefinition,
	CollectionDefinition,
} from '../definition/define-collection';
import type { StampNames } from '../definition/stamps';
import { type SyncOptions, syncCollection } from '../sync/sync-collection';
import { distinct } from './aggregation/distinct';
import { type GroupByRuntime, groupBy } from './aggregation/group-by';
import { populate } from './aggregation/populate';
import { gated } from './auto-sync';
import { subscribe } from './changes/subscription';
import type { ChangeHandler, ChangeOptions } from './changes/types';
import { type CollectionContext, createContext } from './context';
import type { Fields } from './filters';
import {
	hookedCreate,
	hookedCreateMany,
	hookedDelete,
	hookedDeleteMany,
	hookedRestore,
	hookedUpdate,
	hookedUpdateMany,
	type Self,
} from './hooks/hooked';
import { paginate, paginateByCursor } from './operations/paginate';
import {
	countDocuments,
	exists,
	findById,
	findFirst,
	findMany,
	getById,
} from './operations/reads';
import type { CollectionOptions, TypedCollection } from './types';

/** What a collection can be reached through: a database, or a client. */
export type CollectionSource = Db | MongoClient;

/**
 * A `Db`, from either. A client is told from a database by its `db` method,
 * not by `instanceof`, which answers `false` across two copies of the driver.
 */
function databaseOf(source: CollectionSource, name: string | undefined): Db {
	const client = source as MongoClient;
	if (typeof client.db === 'function') return client.db(name);
	const db = source as Db;
	if (name !== undefined && db.databaseName !== name) {
		throw new TypeError(
			`getCollection: given a Db for "${db.databaseName}", and a db option of ` +
				`"${name}". Pass the client, or the database you mean.`,
		);
	}
	return db;
}

/**
 * A collection: this package's methods and the driver's own, on one object.
 *
 * ```ts
 * const users = getCollection(db, usersDefinition);
 *
 * const ada = await users.create({ email: 'ada@example.com' });
 * await users.update(ada._id, { name: 'Ada', version: ada.version });
 * await users.aggregate([{ $group: { _id: '$teamId', n: { $sum: 1 } } }]);
 * ```
 *
 * It takes a `Db`, or a `MongoClient` — then the database is the URI's, or the
 * one named in `{ db }`.
 *
 * Every operation runs in the collection's session, which `withSession` sets:
 * MongoDB has no ambient session, so a write inside a transaction that was not
 * given one is not part of it and is not rolled back.
 */
export function getCollection<
	Schema extends z.ZodObject,
	Names extends StampNames = StampNames,
>(
	source: CollectionSource,
	definition: CollectionDefinition<Schema, Names>,
	// The definition alone decides the types: inferring them from the options
	// too let a hook set typed for another collection widen them until it fit.
	options: NoInfer<CollectionOptions<CollectionDefinition<Schema, Names>>> = {},
): TypedCollection<CollectionDefinition<Schema, Names>> {
	const db = databaseOf(source, options.db);
	return build(db, definition, options as CollectionOptions<never>);
}

/**
 * This package's methods, bound to a context. Each one lives in a subject
 * folder — `operations/`, `hooks/`, `changes/`, `aggregation/`; this is only
 * the surface they are reached by.
 */
function apiOf(ctx: CollectionContext, rebuild: Rebuild, self: Self) {
	return {
		definition: ctx.definition,
		db: ctx.db,
		raw: ctx.collection,
		session: ctx.session,

		withSession: (other: ClientSession | undefined) =>
			rebuild({ session: other }),
		as: (who: unknown) => rebuild({ actor: who as never }),
		sync: (syncOptions: SyncOptions = {}) =>
			syncCollection(ctx.db, ctx.definition, {
				...ctx.sessionOption,
				...syncOptions,
			}),

		findById: (id: unknown, opts?: { withDeleted?: boolean }) =>
			findById(ctx, id, opts),
		getById: (id: unknown, opts?: { withDeleted?: boolean }) =>
			getById(ctx, id, opts),
		findFirst: (filter?: unknown, opts?: Fields) =>
			findFirst(ctx, filter, opts),
		findMany: (opts?: Fields) => findMany(ctx, opts),

		create: (values: unknown) => hookedCreate(ctx, self, values),
		createMany: (values: readonly unknown[]) =>
			hookedCreateMany(ctx, self, values),
		update: (id: unknown, patch: unknown) => hookedUpdate(ctx, self, id, patch),
		updateMany: (filter: unknown, patch: unknown) =>
			hookedUpdateMany(ctx, self, filter, patch),

		delete: (id: unknown) => hookedDelete(ctx, self, id, false),
		deleteMany: (filter: unknown) => hookedDeleteMany(ctx, self, filter, false),
		hardDelete: (id: unknown) => hookedDelete(ctx, self, id, true),
		hardDeleteMany: (filter: unknown) =>
			hookedDeleteMany(ctx, self, filter, true),
		restore: (id: unknown) => hookedRestore(ctx, self, id),

		count: (filter?: unknown, opts?: { withDeleted?: boolean }) =>
			countDocuments(ctx, filter, opts),
		exists: (filter: unknown, opts?: { withDeleted?: boolean }) =>
			exists(ctx, filter, opts),
		paginate: (opts?: Fields) => paginate(ctx, opts),
		paginateByCursor: (opts?: Fields) => paginateByCursor(ctx, opts),

		distinct: (field: string, filter?: unknown, opts?: Fields) =>
			distinct(ctx, field, { ...opts, filter }),
		groupBy: (field: string, opts?: GroupByRuntime) =>
			groupBy(ctx, field, opts),
		populate: (documents: readonly unknown[], relations: Fields) =>
			populate(ctx, documents, relations),
		onChange: (handler: ChangeHandler<never>, opts?: ChangeOptions<never>) =>
			subscribe(ctx, handler, opts),
	};
}

/**
 * The same collection with one option changed, as `withSession` and `as`
 * give it back. It answers `unknown` because the collection this package
 * hands out is typed by the cast at the end of `build`, not by `apiOf`.
 */
type Rebuild = (changed: Partial<CollectionOptions<never>>) => unknown;

function build<Def>(
	db: Db,
	definition: AnyCollectionDefinition,
	options: CollectionOptions<never>,
): TypedCollection<Def> {
	const ctx = createContext(db, definition, options);
	const rebuild: Rebuild = (changed) =>
		build(db, definition, { ...options, ...changed });
	let proxy: TypedCollection<Def> | undefined;
	const api = apiOf(ctx, rebuild, () => proxy);
	const collection = ctx.collection;
	const autoSync = options.autoSync === true;

	/**
	 * This package's methods first, the driver's collection behind them. A
	 * name both define — `count`, `updateMany`, `deleteMany` — is this
	 * package's; the driver's is on `raw`.
	 *
	 * A proxy rather than a copy, so that a method the driver gains is on the
	 * collection without this package being republished.
	 */
	proxy = new Proxy(api, {
		get(target, key, receiver) {
			if (Reflect.has(target, key)) {
				const own = Reflect.get(target, key, receiver);
				return autoSync ? gated(db, definition, key, own) : own;
			}
			const value = (collection as unknown as Fields)[key as string];
			return typeof value === 'function' ? value.bind(collection) : value;
		},
		has(target, key) {
			return Reflect.has(target, key) || key in (collection as object);
		},
	}) as unknown as TypedCollection<Def>;
	return proxy;
}
