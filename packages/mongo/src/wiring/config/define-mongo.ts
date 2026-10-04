import { WiringError } from '../../errors/wiring-error';
import { checkDatabase } from './checks';
import type {
	Checked,
	DatabaseConfig,
	MongoConfig,
	MongoConfigInput,
} from './types';

/** Whether the config named its databases, or is one database itself. */
function databasesOf(
	config: MongoConfigInput,
): Record<string, DatabaseConfig<object>> {
	if (typeof config !== 'object' || config === null) {
		throw new WiringError(
			'CONFIG',
			'defineMongo: a configuration object is required',
		);
	}
	if (!('databases' in config)) {
		return { default: config as DatabaseConfig<object> };
	}
	const { databases } = config;
	if (typeof databases !== 'object' || databases === null) {
		throw new WiringError(
			'CONFIG',
			'defineMongo: databases must be an object of databases by name, ' +
				'as `{ databases: { main: … } }`. One database is the ' +
				'configuration itself, and names itself with `database`.',
		);
	}
	const names = Object.keys(databases);
	if (names.length === 0) {
		throw new WiringError(
			'CONFIG',
			'defineMongo: databases names none. Give it at least one, ' +
				'as `{ databases: { main: … } }`.',
		);
	}
	return databases as Record<string, DatabaseConfig<object>>;
}

/**
 * The configuration of an application's MongoDB, checked once and frozen.
 *
 * ```ts
 * import * as collections from './models';
 *
 * export const config = defineMongo({
 * 	uri: process.env.MONGO_URI!,
 * 	collections,
 * });
 * ```
 *
 * Several databases name themselves:
 *
 * ```ts
 * defineMongo({
 * 	databases: {
 * 		main: { uri: process.env.MONGO_URI!, collections },
 * 		analytics: { uri: process.env.ANALYTICS_URI!, collections: events },
 * 	},
 * });
 * ```
 *
 * It connects to nothing and reads no environment variable: what is wrong
 * with the configuration throws here, where the application starts, and the
 * variables are the application's to read.
 */
export function defineMongo<const C extends MongoConfigInput>(
	config: C & Checked<C>,
): MongoConfig<C> {
	const databases = databasesOf(config);
	for (const [name, database] of Object.entries(databases)) {
		checkDatabase(name, database);
	}
	return Object.freeze({
		databases: Object.freeze({ ...databases }),
	}) as MongoConfig<C>;
}
