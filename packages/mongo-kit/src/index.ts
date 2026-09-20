export { defineConfig } from './config/define-config';
export type {
	CollectionsIn,
	CollectionsOf,
	DatabaseConfig,
	DbName,
	KitCollectionOptions,
	KitConfig,
	KitConfigInput,
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
	DbScope,
	KitActor,
	KitOf,
	KitTransactionOptions,
	MongoKit,
	SoleScope,
} from './kit/types';
