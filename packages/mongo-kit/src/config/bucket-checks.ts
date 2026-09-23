import type { BucketDefinition } from '@nxgt/mongo/gridfs';
import { refuse } from './refuse';
import type { DatabaseConfig } from './types';

/**
 * A bucket definition, told by its shape as `isDefinition` tells a
 * collection: a name, and the two collections GridFS keeps under it. A
 * collection definition has no `collections`, so the two never overlap.
 */
export function isBucket(value: unknown): value is BucketDefinition {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<BucketDefinition>;
	const collections = candidate.collections as
		| Partial<BucketDefinition['collections']>
		| undefined;
	return (
		typeof candidate.name === 'string' &&
		typeof collections === 'object' &&
		collections !== null &&
		typeof collections.files === 'string' &&
		typeof collections.chunks === 'string' &&
		'metadata' in candidate &&
		'chunkSize' in candidate
	);
}

/** The bucket definitions of a module object, under the keys they are exported by. */
export function bucketsOf(buckets: object): [string, BucketDefinition][] {
	return Object.entries(buckets).filter(
		(entry): entry is [string, BucketDefinition] => isBucket(entry[1]),
	);
}

/** The bucket options the kit decides: the session, and the database's `autoSync`. */
const OWNED_BY_BUCKETS = ['session', 'autoSync'] as const;

/**
 * `bucketOptions` with no bucket to apply to, or with `session` or
 * `autoSync` in it, which would outrank the kit.
 */
function checkBucketOptions(
	name: string,
	options: unknown,
	hasBuckets: boolean,
): void {
	if (options === undefined) return;
	if (!hasBuckets) {
		refuse(
			name,
			'has bucketOptions but no buckets: pass the buckets they are for, or leave them out',
		);
	}
	if (typeof options !== 'object' || options === null) return;
	for (const key of OWNED_BY_BUCKETS) {
		if (key in options) {
			refuse(
				name,
				`has "${key}" in bucketOptions, which the kit decides: ` +
					"`withSession` and transactions carry the session, and `autoSync` is the database's",
			);
		}
	}
}

/**
 * What a database's `buckets` and `bucketOptions` must answer. A key the
 * driver's `Db` answers to is refused by `createKit`, which has a `Db` to ask
 * with `in`, exactly as it is for a collection: there is none here.
 */
export function checkBuckets(
	name: string,
	config: DatabaseConfig<object>,
	collectionKeys: ReadonlySet<string>,
): void {
	checkBucketOptions(name, config.bucketOptions, config.buckets !== undefined);
	if (config.buckets === undefined) return;
	const buckets =
		typeof config.buckets === 'object' && config.buckets !== null
			? bucketsOf(config.buckets)
			: [];
	if (buckets.length === 0) {
		refuse(
			name,
			'has a buckets object with no bucket definition in it: pass the module, as in `import * as buckets`',
		);
	}
	const byName = new Map<string, string>();
	for (const [key, definition] of buckets) {
		if (collectionKeys.has(key)) {
			refuse(
				name,
				`wires "${key}" as both a collection and a bucket: export one of them under another name`,
				key,
			);
		}
		const seen = byName.get(definition.name);
		if (seen !== undefined) {
			refuse(
				name,
				`wires "${seen}" and "${key}" to the same bucket, "${definition.name}"`,
				key,
			);
		}
		byName.set(definition.name, key);
	}
}
