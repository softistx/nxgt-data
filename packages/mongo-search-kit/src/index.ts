import {
	createSearchSyncs,
	type IndexMap,
	type RunningSearchSyncs,
	type SearchSyncs,
	type SearchSyncsConfig,
} from '@nxgt/mongo-meilisearch';

// This package moved into `@nxgt/mongo-meilisearch`. Every name below is that
// package's, re-exported; the ones that were renamed keep their old spelling
// as a deprecated alias until the next major.

export type {
	ByKey,
	IndexMap,
	SoleCollections,
} from '@nxgt/mongo-meilisearch';

/** @deprecated Use createSearchSyncs from @nxgt/mongo-meilisearch */
export const createSearchKit = createSearchSyncs;

/** @deprecated Use SearchSyncs from @nxgt/mongo-meilisearch */
export type SearchKit<I> = SearchSyncs<I>;

/** @deprecated Use RunningSearchSyncs from @nxgt/mongo-meilisearch */
export type RunningSearchKit<I> = RunningSearchSyncs<I>;

/** @deprecated Use SearchSyncsConfig from @nxgt/mongo-meilisearch */
export type SearchConfig<C, I extends IndexMap<I>> = SearchSyncsConfig<C, I>;

/** @deprecated Use SearchSyncEntry from @nxgt/mongo-meilisearch */
export type { SearchSyncEntry as SearchEntry } from '@nxgt/mongo-meilisearch';
