import type { AnyCollectionDefinition } from '@nxgt/mongo';
import { checkBuckets } from './bucket-checks';
import { refuse } from './refuse';
import type { DatabaseConfig } from './types';

/** A definition, told by its shape: `instanceof` has no class to ask. */
export function isDefinition(value: unknown): value is AnyCollectionDefinition {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<AnyCollectionDefinition>;
	return (
		typeof candidate.name === 'string' &&
		typeof candidate.schema === 'object' &&
		candidate.schema !== null &&
		Array.isArray(candidate.indexes) &&
		typeof candidate.stamps === 'object'
	);
}

/** The definitions of a module object, under the keys they are exported by. */
export function definitionsOf(
	collections: object,
): [string, AnyCollectionDefinition][] {
	return Object.entries(collections).filter(
		(entry): entry is [string, AnyCollectionDefinition] =>
			isDefinition(entry[1]),
	);
}

/**
 * The collection options the kit decides itself: the database each collection
 * is on, the session and the actor a derived kit carries, and the sync the
 * database's `autoSync` asks for. The types refuse them in `options`, where
 * the shape is `KitCollectionOptions`; under `optionsFor` they are only
 * refused here, and one of them there would quietly outrank the kit.
 */
const OWNED = ['db', 'session', 'actor', 'autoSync'] as const;

function checkOwned(
	name: string,
	what: string,
	options: unknown,
	forKey?: string,
): void {
	if (typeof options !== 'object' || options === null) return;
	for (const key of OWNED) {
		if (key in options) {
			refuse(
				name,
				`has "${key}" in ${what}, which the kit decides: ` +
					'a database is named by its key, `as` and `withSession` carry the ' +
					"actor and the session, and `autoSync` is the database's",
				forKey,
			);
		}
	}
}

/** Everything one database's config must answer before anything connects. */
export function checkDatabase(
	name: string,
	config: DatabaseConfig<object>,
): [string, AnyCollectionDefinition][] {
	if (typeof config !== 'object' || config === null) {
		refuse(name, 'is not a configuration object');
	}
	const hasUri = config.uri !== undefined;
	const hasClient = config.client !== undefined;
	if (hasUri === hasClient) {
		refuse(
			name,
			hasUri
				? 'has both a uri and a client: pass the one it should use'
				: 'has neither a uri nor a client',
		);
	}
	if (hasUri && (typeof config.uri !== 'string' || config.uri === '')) {
		refuse(name, 'has a uri that is not a string');
	}
	if (hasClient && typeof config.client?.db !== 'function') {
		refuse(name, 'has a client that is not a MongoClient');
	}
	if (hasClient && config.clientOptions !== undefined) {
		refuse(
			name,
			'has client options beside a client it did not open: pass them where the client is made',
		);
	}
	if (config.database !== undefined && config.database === '') {
		refuse(name, 'has an empty database name');
	}
	if (typeof config.collections !== 'object' || config.collections === null) {
		refuse(name, 'has no collections object');
	}
	const definitions = definitionsOf(config.collections);
	if (definitions.length === 0) {
		refuse(
			name,
			'has a collections object with no definition in it: pass the module, as in `import * as collections`',
		);
	}
	const byName = new Map<string, string>();
	for (const [key, definition] of definitions) {
		const seen = byName.get(definition.name);
		if (seen !== undefined) {
			refuse(
				name,
				`wires "${seen}" and "${key}" to the same collection, "${definition.name}"`,
			);
		}
		byName.set(definition.name, key);
	}
	const keys = new Set(definitions.map(([key]) => key));
	for (const key of Object.keys(config.optionsFor ?? {})) {
		if (!keys.has(key)) {
			refuse(name, `has options for "${key}", which it does not wire`, key);
		}
	}
	checkOwned(name, 'options', config.options);
	for (const [key, options] of Object.entries(config.optionsFor ?? {})) {
		checkOwned(name, `the options of "${key}"`, options, key);
	}
	checkBuckets(name, config, keys);
	return definitions;
}
