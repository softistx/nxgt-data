import { WiringError } from '../errors/wiring-error';
import type { SyncOptions } from '../sync/sync-collection';
import { databaseOf, derived, type WiringContext } from './context';
import { pingMongo } from './ping';
import { scopeOf } from './scope';
import { syncMongo, syncMongoBuckets } from './sync';
import { transact } from './transaction';
import type { Mongo, MongoTransactionOptions } from './types';

/**
 * Closes what this Mongo's context opened. Idempotent, because each
 * `MongoConnection` is: a second call awaits the first one's work.
 */
async function closeOpened(ctx: WiringContext): Promise<void> {
	if (!ctx.root) {
		throw new WiringError(
			'DERIVED',
			'close: this Mongo came from `as`, `withSession` or a transaction. ' +
				'Close the one `openMongo` returned — the clients are shared.',
		);
	}
	for (const database of ctx.databases) {
		await database.connection?.close();
	}
}

/**
 * A Mongo over one context. `as` and `withSession` build another over a new
 * context, sharing the databases and the clients: only the collections are
 * built again, and only the ones a caller reads.
 */
export function mongoOf<C>(ctx: WiringContext): Mongo<C> {
	const scopes = new Map<string, object>();
	const scopeFor = (name: string): object => {
		const found = scopes.get(name);
		if (found) return found;
		const scope = scopeOf(ctx, databaseOf(ctx, name));
		scopes.set(name, scope);
		return scope;
	};

	const databases = {} as Record<string, object>;
	const clients = {} as Record<string, unknown>;
	for (const database of ctx.databases) {
		Object.defineProperty(databases, database.name, {
			enumerable: true,
			get: () => scopeFor(database.name),
		});
		Object.defineProperty(clients, database.name, {
			enumerable: true,
			value: database.client,
		});
	}

	const mongo: Mongo<C> = {
		get db() {
			const [only] = ctx.databases;
			if (ctx.databases.length !== 1 || !only) {
				throw new WiringError(
					'SEVERAL_DATABASES',
					'db: this Mongo has several databases. Read the one you mean, ' +
						`as \`mongo.databases.${ctx.databases[0]?.name ?? 'main'}\`.`,
				);
			}
			return scopeFor(only.name) as never;
		},
		databases: databases as never,
		clients: clients as never,
		get actor() {
			return ctx.actor as never;
		},
		get session() {
			return ctx.session;
		},
		as(actor) {
			return mongoOf<C>(derived(ctx, { actor }));
		},
		withSession(session) {
			return mongoOf<C>(derived(ctx, { session }));
		},
		transaction<T>(
			fn: (mongo: Mongo<C>) => Promise<T>,
			options?: MongoTransactionOptions<C>,
		): Promise<T> {
			return transact(
				ctx,
				(next) => mongoOf<C>(next),
				fn as never,
				options as never,
			);
		},
		sync(options?: SyncOptions) {
			return syncMongo(ctx, options) as never;
		},
		syncBuckets() {
			return syncMongoBuckets(ctx) as never;
		},
		ping(options?: { timeoutMS?: number }) {
			return pingMongo(ctx, options) as never;
		},
		close() {
			return closeOpened(ctx);
		},
		[Symbol.asyncDispose]() {
			return closeOpened(ctx);
		},
	};
	return mongo;
}
