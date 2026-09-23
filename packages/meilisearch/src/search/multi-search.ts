import type {
	Meilisearch,
	MultiSearchQuery as SdkMultiSearchQuery,
} from 'meilisearch';
import type { AnyIndexDefinition } from '../definition/define-index';
import type { TypedIndex } from '../index/bind-index';
import type { SearchOptions, SearchResult } from '../index/types';

/**
 * One query of a `multiSearch`: the typed index it runs on, its `q`, and the
 * search options of `search`, typed by that index's definition.
 */
export type MultiSearchQuery<Def extends AnyIndexDefinition> =
	SearchOptions<Def> & {
		index: TypedIndex<Def>;
		q?: string | null;
	};

/** The definition of the index a query runs on. */
type DefinitionOf<Q> = Q extends {
	index: { definition: infer Def extends AnyIndexDefinition };
}
	? Def
	: never;

/**
 * A query as its own index allows it: the options typed by that index, and
 * no key `search` does not take — a misspelt one would otherwise pass, since
 * the query's type is inferred from the query itself.
 */
export type CheckedQuery<Q> = MultiSearchQuery<DefinitionOf<Q>> & {
	[K in Exclude<keyof Q, keyof MultiSearchQuery<DefinitionOf<Q>>>]: never;
};

/**
 * What `multiSearch` resolves to: one result per query, in order, each typed
 * as `search` on its own index types it, with the `indexUid` it ran on.
 */
export type MultiSearchResults<Queries extends readonly unknown[]> = {
	-readonly [K in keyof Queries]: SearchResult<
		DefinitionOf<Queries[K]>,
		Queries[K]
	> & { indexUid: string };
};

/**
 * Runs several searches in one request, each on its own typed index, and
 * resolves to their results in the same order, each typed by its index:
 *
 * ```ts
 * const [films, people] = await multiSearch(client, [
 * 	{ index: movieIndex, q: 'alien', sort: ['year:desc'] },
 * 	{ index: peopleIndex, q: 'ridley', facets: ['country'] },
 * ]);
 * ```
 *
 * It is the SDK's `client.multiSearch({ queries })`, with each `index`
 * replaced by its `indexUid`. A query Meilisearch refuses fails the whole
 * request with the SDK's `MeilisearchApiError`, as it does without this
 * package. Federated search is not wrapped: use `client.multiSearch`.
 */
export async function multiSearch<
	// Not `MultiSearchQuery<any>[]`: that constraint stops the query list
	// from being inferred as a tuple, and every result falls back to `any`.
	const Queries extends readonly { index: TypedIndex<any> }[],
>(
	client: Meilisearch,
	queries: Queries & {
		readonly [K in keyof Queries]: CheckedQuery<Queries[K]>;
	},
): Promise<MultiSearchResults<Queries>> {
	const { results } = await client.multiSearch({
		// The options are the SDK's, `readonly` where this package reads them.
		queries: queries.map(
			({ index, ...options }): SdkMultiSearchQuery =>
				({ ...options, indexUid: index.uid }) as SdkMultiSearchQuery,
		),
	});
	return results as unknown as MultiSearchResults<Queries>;
}
