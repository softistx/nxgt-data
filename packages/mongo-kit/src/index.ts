import {
	type DbMemberName,
	defineMongo,
	type Mongo,
	type MongoActor,
	type MongoConfig,
	type MongoConfigInput,
	type MongoOf,
	type MongoTransactionOptions,
	openMongo,
	type WiredBucketOptions,
	type WiredCollectionOptions,
	WiringError,
	type WiringErrorCode,
	type WiringErrorOptions,
} from '@nxgt/mongo';

// This package moved into `@nxgt/mongo`. Every name below is that package's,
// re-exported; the ones that were renamed keep their old spelling as a
// deprecated alias until the next major.

export {
	type BucketSyncReport,
	type BucketsIn,
	type BucketsOf,
	type CollectionsIn,
	type CollectionsOf,
	type DatabaseConfig,
	type DbName,
	type DbScope,
	type DiscoverOptions,
	discoverCollections,
	type NoBucketCollision,
	type NoBucketsToOption,
	type NoCollision,
	type NoOwnedBucketOption,
	type SoleScope,
	type Unwired,
} from '@nxgt/mongo';

/** @deprecated Use openMongo from @nxgt/mongo */
export const createKit = openMongo;

/** @deprecated Use defineMongo from @nxgt/mongo */
export const defineConfig = defineMongo;

/** @deprecated Use WiringError from @nxgt/mongo */
export const KitError = WiringError;
/** @deprecated Use WiringError from @nxgt/mongo */
export type KitError = WiringError;

/** @deprecated Use WiringErrorCode from @nxgt/mongo */
export type KitErrorCode = WiringErrorCode;

/** @deprecated Use WiringErrorOptions from @nxgt/mongo */
export type KitErrorOptions = WiringErrorOptions;

/** @deprecated Use Mongo from @nxgt/mongo */
export type MongoKit<C> = Mongo<C>;

/** @deprecated Use MongoOf from @nxgt/mongo */
export type KitOf<Config> = MongoOf<Config>;

/** @deprecated Use MongoConfig from @nxgt/mongo */
export type KitConfig<C> = MongoConfig<C>;

/** @deprecated Use MongoConfigInput from @nxgt/mongo */
export type KitConfigInput = MongoConfigInput;

/** @deprecated Use MongoActor from @nxgt/mongo */
export type KitActor<C> = MongoActor<C>;

/** @deprecated Use MongoTransactionOptions from @nxgt/mongo */
export type KitTransactionOptions<C> = MongoTransactionOptions<C>;

/** @deprecated Use WiredBucketOptions from @nxgt/mongo */
export type KitBucketOptions = WiredBucketOptions;

/** @deprecated Use WiredCollectionOptions from @nxgt/mongo */
export type KitCollectionOptions<Def> = WiredCollectionOptions<Def>;

/** @deprecated Use DbMemberName from @nxgt/mongo */
export type ReservedName = DbMemberName;
