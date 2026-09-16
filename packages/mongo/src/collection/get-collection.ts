import type { ClientSession, Db, MongoClient } from 'mongodb';
import type { z } from 'zod';
import type {
	AnyCollectionDefinition,
	CollectionDefinition,
} from '../definition/define-collection';
import type { StampNames } from '../definition/stamps';
import { type SyncOptions, syncCollection } from '../sync/sync-collection';
import { type CollectionContext, createContext } from './context';
import type { Fields } from './filters';
import { paginate, paginateByCursor } from './paginate';
import {
	countDocuments,
	exists,
	findById,
	findFirst,
	findMany,
	getById,
} from './reads';
import type { CollectionOptions, TypedCollection } from './types';
import {
	create,
	createMany,
	deleteMany,
	deleteOne,
	hardDelete,
	hardDeleteMany,
	restore,
	update,
	updateMany,
} from './writes';

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
 * await users.update(ada._id, { name: 'Ada' }, { expectedVersion: ada.version });
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
	options: CollectionOptions<CollectionDefinition<Schema, Names>> = {},
): TypedCollection<CollectionDefinition<Schema, Names>> {
	const db = databaseOf(source, options.db);
	return build(db, definition, options as CollectionOptions<never>);
}

/**
 * This package's methods, bound to a context. Each one lives in `reads`,
 * `writes` or `paginate`; this is only the surface they are reached by.
 */
function apiOf(ctx: CollectionContext, rebuild: Rebuild) {
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

		create: (values: unknown) => create(ctx, values),
		createMany: (values: readonly unknown[]) => createMany(ctx, values),
		update: (id: unknown, patch: unknown, opts?: Fields) =>
			update(ctx, id, patch, opts),
		updateMany: (filter: unknown, patch: unknown) =>
			updateMany(ctx, filter, patch),

		delete: (id: unknown) => deleteOne(ctx, id),
		deleteMany: (filter: unknown) => deleteMany(ctx, filter),
		hardDelete: (id: unknown) => hardDelete(ctx, id),
		hardDeleteMany: (filter: unknown) => hardDeleteMany(ctx, filter),
		restore: (id: unknown) => restore(ctx, id),

		count: (filter?: unknown, opts?: { withDeleted?: boolean }) =>
			countDocuments(ctx, filter, opts),
		exists: (filter: unknown, opts?: { withDeleted?: boolean }) =>
			exists(ctx, filter, opts),
		paginate: (opts?: Fields) => paginate(ctx, opts),
		paginateByCursor: (opts?: Fields) => paginateByCursor(ctx, opts),
	};
}

/**
 * The syncs `autoSync` has started, per database and per collection, so that
 * every collection of the same database waits on the same one — including the
 * ones `withSession` and `as` build, which are the same collection again.
 *
 * A sync that failed is forgotten, so the next call tries again: a server that
 * was not up yet is not a reason to refuse every operation for the life of the
 * process.
 */
let syncs = new WeakMap<Db, Map<string, Promise<unknown>>>();

/**
 * Forgets the syncs `autoSync` has already run, for one database or for all.
 *
 * The memo is what makes `autoSync` sync once and not before every call, and
 * it outlives the collection itself — a `dropDatabase` leaves this package
 * thinking a collection it can no longer see is in shape. A test that empties
 * its database between cases calls this alongside.
 */
export function resetAutoSync(db?: Db): void {
	if (db) syncs.delete(db);
	else syncs = new WeakMap();
}

function syncOnce(
	db: Db,
	definition: AnyCollectionDefinition,
): Promise<unknown> {
	let byName = syncs.get(db);
	if (!byName) {
		byName = new Map();
		syncs.set(db, byName);
	}
	const started = byName.get(definition.name);
	if (started) return started;
	const running = syncCollection(db, definition);
	byName.set(definition.name, running);
	running.catch(() => byName.delete(definition.name));
	return running;
}

/**
 * What does not wait for `autoSync`: the properties, the two that build
 * another collection, and `sync` itself.
 */
const UNGATED = new Set([
	'definition',
	'db',
	'raw',
	'session',
	'withSession',
	'as',
	'sync',
]);

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
	const api = apiOf(ctx, rebuild);
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
	return new Proxy(api, {
		get(target, key, receiver) {
			if (Reflect.has(target, key)) {
				const own = Reflect.get(target, key, receiver);
				if (
					!autoSync ||
					typeof own !== 'function' ||
					UNGATED.has(key as string)
				) {
					return own;
				}
				// The sync is looked up per call, not captured here: that is one
				// map lookup, and it is what lets `resetAutoSync` reach a
				// collection somebody is already holding.
				return (...args: unknown[]) =>
					syncOnce(db, definition).then(() =>
						(own as (...a: unknown[]) => unknown)(...args),
					);
			}
			const value = (collection as unknown as Fields)[key as string];
			return typeof value === 'function' ? value.bind(collection) : value;
		},
		has(target, key) {
			return Reflect.has(target, key) || key in (collection as object);
		},
	}) as unknown as TypedCollection<Def>;
}
