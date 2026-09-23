// A search kit over `@nxgt/mongo-kit`: one config naming an index and a
// transform per collection, and one `syncIndexes`, `reindexAll`, `start` and
// `close` for all of them. Each collection's sync is `@nxgt/mongo-meilisearch`'s, unchanged.

export type {
	IndexMap,
	SearchConfig,
	SearchEntry,
	SoleCollections,
} from './config/types';
export { createSearchKit } from './kit/create-search-kit';
export type { ByKey, RunningSearchKit, SearchKit } from './kit/types';
