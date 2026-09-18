import { type TransactionHost, withTransaction } from '@nxgt/mongo';
import type { MongoClient, TransactionOptions } from 'mongodb';
import { databaseOf, derived, type KitContext } from './context';

/**
 * The client a transaction runs on. One transaction lives on one client, so
 * a kit holding several has to be told which — there is no transaction
 * across clients to give.
 */
export function clientFor(
	ctx: KitContext,
	on: string | undefined,
): MongoClient {
	if (on !== undefined) return databaseOf(ctx, on).client;
	const clients = new Set(ctx.databases.map((database) => database.client));
	const [only] = clients;
	if (clients.size === 1 && only) return only;
	throw new TypeError(
		'transaction: this kit holds more than one client, and a transaction ' +
			"lives on one. Name the database it runs on, as `{ on: 'main' }`.",
	);
}

/**
 * What the transaction runs on: the kit's own session when it has one, so
 * that a transaction inside a transaction **joins** the outer one rather than
 * opening a second, independent one beside it; a client otherwise.
 */
export function hostFor(
	ctx: KitContext,
	on: string | undefined,
): TransactionHost {
	if (!ctx.session) return clientFor(ctx, on);
	if (on !== undefined) {
		throw new TypeError(
			'transaction: this kit is already in a session, which this call ' +
				'joins, so `on` has no client left to choose.',
		);
	}
	return ctx.session;
}

/**
 * Runs `fn` in a transaction, with a kit whose collections are all in it.
 * The driver retries `fn` from the start on a transient error, so `fn` must
 * be safe to run twice — `@nxgt/mongo`'s `withTransaction` says the rest.
 */
export async function transact<T>(
	ctx: KitContext,
	build: (ctx: KitContext) => unknown,
	fn: (kit: never) => Promise<T>,
	options: (TransactionOptions & { on?: string }) | undefined,
): Promise<T> {
	const { on, ...rest } = options ?? {};
	const host = hostFor(ctx, on);
	const transactionOptions =
		Object.keys(rest).length > 0 ? (rest as TransactionOptions) : undefined;
	return withTransaction(
		host,
		(session) => fn(build(derived(ctx, { session })) as never),
		transactionOptions,
	);
}
