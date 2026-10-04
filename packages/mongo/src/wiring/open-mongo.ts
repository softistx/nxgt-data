import type { Db } from 'mongodb';
import { connectMongo, type MongoConnection } from '../connection/connect';
import { WiringError } from '../errors/wiring-error';
import { bucketsOf } from './config/bucket-checks';
import { checkDatabase } from './config/checks';
import type { DatabaseConfig, MongoConfig } from './config/types';
import type { DatabaseContext, WiringContext } from './context';
import { mongoOf } from './derive';
import type { Mongo } from './types';

/** Where one database is, and whether the Mongo opened it itself. */
async function open(
	config: DatabaseConfig<object>,
): Promise<{ db: Db; connection: MongoConnection | undefined }> {
	if (config.client) {
		const client = config.client;
		return {
			db: config.database ? client.db(config.database) : client.db(),
			connection: undefined,
		};
	}
	const connection = await connectMongo(
		config.uri as string,
		config.clientOptions,
	);
	return {
		db: config.database ? connection.client.db(config.database) : connection.db,
		connection,
	};
}

/**
 * A key the driver's `Db` already answers to would be unreachable on the
 * scope. The types refuse it where the config is written; this asks the
 * object itself, so a member the driver adds in a later release is caught
 * here rather than silently shadowed. A bucket's key is asked the same
 * question, since it sits on the same scope.
 */
function checkCollisions(
	name: string,
	db: Db,
	keys: readonly string[],
	what: 'collection' | 'bucket',
): void {
	for (const key of keys) {
		if (key in db) {
			throw new WiringError(
				'COLLISION',
				`openMongo: database "${name}" wires a ${what} under "${key}", ` +
					"which is a member of the driver's Db: it would be unreachable. " +
					'Export that definition under another name.',
				{ database: name, key },
			);
		}
	}
}

/**
 * Opens what the configuration describes, and gives the application its
 * collections on their database.
 *
 * ```ts
 * await using mongo = await openMongo(config);
 * const user = await mongo.db.users.create({ email: 'ada@example.com' });
 * ```
 *
 * A database with a `uri` takes a hold on the client `connectMongo` shares
 * for that URI, and `close()` gives it back; a database given a `client` uses
 * it and never closes it. Nothing is built ahead of the connections: a
 * collection is built the first time it is read.
 */
export async function openMongo<C>(config: MongoConfig<C>): Promise<Mongo<C>> {
	const entries = Object.entries(config.databases) as [
		string,
		DatabaseConfig<object>,
	][];
	const databases: DatabaseContext[] = [];
	try {
		for (const [name, database] of entries) {
			const wired = checkDatabase(name, database);
			const buckets = bucketsOf(database.buckets ?? {});
			const { db, connection } = await open(database);
			databases.push({
				name,
				db,
				client: connection?.client ?? (database.client as never),
				wired,
				options: (database.options ?? {}) as never,
				optionsFor: (database.optionsFor ?? {}) as never,
				autoSync: database.autoSync === true,
				buckets,
				bucketOptions: database.bucketOptions ?? {},
				connection,
			});
			checkCollisions(
				name,
				db,
				wired.map(([key]) => key),
				'collection',
			);
			checkCollisions(
				name,
				db,
				buckets.map(([key]) => key),
				'bucket',
			);
		}
	} catch (error) {
		// Whatever opened before the failure is this call's to give back.
		for (const database of databases) await database.connection?.close();
		throw error;
	}
	const ctx: WiringContext = {
		databases,
		session: undefined,
		actor: undefined,
		cache: new Map(),
		root: true,
	};
	return mongoOf<C>(ctx);
}
