import type { AnyIndexDefinition } from '@nxgt/meilisearch';
import type { AnyCollectionDefinition } from '@nxgt/mongo';
import type { CollectionsIn, CollectionsOf, DbName } from '@nxgt/mongo-kit';
import type { SearchSyncOptions } from '@nxgt/mongo-meilisearch';

/**
 * What a kit's sole database holds, by the name each definition is exported
 * under — the same keys `kit.db` answers to.
 *
 * A kit with several databases gives `never`, as `kit.db` itself does: this
 * version follows the collections of one. See the README.
 */
export type SoleCollections<C> =
	DbName<C> extends infer N extends DbName<C>
		? [Exclude<DbName<C>, N>] extends [never]
			? CollectionsOf<CollectionsIn<C, N>>
			: never
		: never;

/**
 * One collection's entry: everything `createSearchSync` takes except the
 * collection itself, which the kit already holds.
 */
export type SearchEntry<
	Col extends AnyCollectionDefinition,
	I extends AnyIndexDefinition,
> = Omit<SearchSyncOptions<Col, I>, 'collection'>;

/** The index definitions a config names, one per key. */
export type IndexMap<I> = { [K in keyof I]: AnyIndexDefinition };

/**
 * The config `createSearchKit` takes: an entry per collection, under the key
 * the kit wires that collection under.
 *
 * `I` is inferred from each entry's `index` alone, which is what lets a
 * `transform` be written inline — its document is typed by the collection the
 * key names, and its result by that index. A key the kit wires no collection
 * for is refused by name.
 */
export type SearchConfig<C, I extends IndexMap<I>> = {
	[K in keyof I]: K extends keyof SoleCollections<C>
		? SoleCollections<C>[K] extends infer Col extends AnyCollectionDefinition
			? SearchEntry<Col, I[K]>
			: never
		: {
				index: `mongo-search-kit: this kit wires no collection called "${K & string}"`;
			};
};
