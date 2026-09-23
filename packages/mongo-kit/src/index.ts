export { defineConfig } from './config/define-config';
export type {
	BucketsIn,
	BucketsOf,
	CollectionsIn,
	CollectionsOf,
	DatabaseConfig,
	DbName,
	KitBucketOptions,
	KitCollectionOptions,
	KitConfig,
	KitConfigInput,
	NoBucketCollision,
	NoCollision,
	ReservedName,
	Unwired,
} from './config/types';
export { type DiscoverOptions, discoverCollections } from './discover';
export {
	KitError,
	type KitErrorCode,
	type KitErrorOptions,
} from './errors/kit-error';
export { createKit } from './kit/create-kit';
export type {
	BucketSyncReport,
	DbScope,
	KitActor,
	KitOf,
	KitTransactionOptions,
	MongoKit,
	SoleScope,
} from './kit/types';
