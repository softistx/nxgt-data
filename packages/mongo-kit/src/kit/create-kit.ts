import { connectMongo, type MongoConnection } from '@nxgt/mongo';
import type { Db } from 'mongodb';
import { checkDatabase } from '../config/checks';
import type { DatabaseConfig, KitConfig } from '../config/types';
import { KitError } from '../errors/kit-error';
import type { DatabaseContext, KitContext } from './context';
import { kitOf } from './derive';
import type { MongoKit } from './types';

/** Where one database is, and whether the kit opened it itself. */
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
 * here rather than silently shadowed.
 */
function checkCollisions(name: string, db: Db, keys: readonly string[]): void {
	for (const key of keys) {
		if (key in db) {
			throw new KitError(
				'COLLISION',
				`createKit: database "${name}" wires a collection under "${key}", ` +
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
 * await using kit = await createKit(config);
 * const user = await kit.db.users.create({ email: 'ada@example.com' });
 * ```
 *
 * A database with a `uri` takes a hold on the client `connectMongo` shares
 * for that URI, and `close()` gives it back; a database given a `client` uses
 * it and never closes it. Nothing is built ahead of the connections: a
 * collection is built the first time it is read.
 */
export async function createKit<C>(config: KitConfig<C>): Promise<MongoKit<C>> {
	const entries = Object.entries(config.databases) as [
		string,
		DatabaseConfig<object>,
	][];
	const databases: DatabaseContext[] = [];
	try {
		for (const [name, database] of entries) {
			const wired = checkDatabase(name, database);
			const { db, connection } = await open(database);
			databases.push({
				name,
				db,
				client: connection?.client ?? (database.client as never),
				wired,
				options: (database.options ?? {}) as never,
				optionsFor: (database.optionsFor ?? {}) as never,
				autoSync: database.autoSync === true,
				connection,
			});
			checkCollisions(
				name,
				db,
				wired.map(([key]) => key),
			);
		}
	} catch (error) {
		// Whatever opened before the failure is this call's to give back.
		for (const database of databases) await database.connection?.close();
		throw error;
	}
	const ctx: KitContext = {
		databases,
		session: undefined,
		actor: undefined,
		cache: new Map(),
		root: true,
	};
	return kitOf<C>(ctx);
}
