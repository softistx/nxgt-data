import type { SyncOptions } from '@nxgt/mongo';
import { KitError } from '../errors/kit-error';
import { databaseOf, derived, type KitContext } from './context';
import { scopeOf } from './scope';
import { syncKit } from './sync';
import { transact } from './transaction';
import type { KitTransactionOptions, MongoKit } from './types';

/**
 * Closes what this kit's context opened. Idempotent, because each
 * `MongoConnection` is: a second call awaits the first one's work.
 */
async function closeKit(ctx: KitContext): Promise<void> {
	if (!ctx.root) {
		throw new KitError(
			'DERIVED',
			'close: this kit came from `as`, `withSession` or a transaction. ' +
				'Close the kit `createKit` returned — the clients are shared.',
		);
	}
	for (const database of ctx.databases) {
		await database.connection?.close();
	}
}

/**
 * A kit over one context. `as` and `withSession` build another over a new
 * context, sharing the databases and the clients: only the collections are
 * built again, and only the ones a caller reads.
 */
export function kitOf<C>(ctx: KitContext): MongoKit<C> {
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

	const kit: MongoKit<C> = {
		get db() {
			const [only] = ctx.databases;
			if (ctx.databases.length !== 1 || !only) {
				throw new KitError(
					'SEVERAL_DATABASES',
					'kit.db: this kit has several databases. Read the one you mean, ' +
						`as \`kit.databases.${ctx.databases[0]?.name ?? 'main'}\`.`,
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
			return kitOf<C>(derived(ctx, { actor }));
		},
		withSession(session) {
			return kitOf<C>(derived(ctx, { session }));
		},
		transaction<T>(
			fn: (kit: MongoKit<C>) => Promise<T>,
			options?: KitTransactionOptions<C>,
		): Promise<T> {
			return transact(
				ctx,
				(next) => kitOf<C>(next),
				fn as never,
				options as never,
			);
		},
		sync(options?: SyncOptions) {
			return syncKit(ctx, options) as never;
		},
		close() {
			return closeKit(ctx);
		},
		[Symbol.asyncDispose]() {
			return closeKit(ctx);
		},
	};
	return kit;
}
