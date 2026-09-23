import type { AnyIndexDefinition } from '@nxgt/meilisearch';
import type { AnyCollectionDefinition } from '@nxgt/mongo';
import { createContext } from './context';
import { reindex } from './reindex';
import { start } from './start';
import { readState } from './state';
import type { SearchSync, SearchSyncOptions } from './types';

/**
 * Keeps an index in step with a collection.
 *
 * ```ts
 * const usersSearch = createSearchSync({
 * 	collection: getCollection(db, users),
 * 	index: bindIndex(meili, userIndex),
 * 	transform: (user) => (user.active ? { id: user.id, name: user.name } : null),
 * });
 * const running = await usersSearch.start();   // reindexes the first time
 * // …
 * await running.close();
 * ```
 *
 * Nothing is sent before `reindex` or `start`.
 */
export function createSearchSync<
	C extends AnyCollectionDefinition,
	I extends AnyIndexDefinition,
>(options: SearchSyncOptions<C, I>): SearchSync {
	// The one place the caller's types are let go: a method taking `IdOf<C>`
	// is not one taking any id, so the widening cannot be implicit. Below
	// here, documents are records and ids are values.
	const ctx = createContext(
		options as unknown as SearchSyncOptions<
			AnyCollectionDefinition,
			AnyIndexDefinition
		>,
	);
	return {
		name: ctx.name,
		reindex: () => reindex(ctx),
		start: () => start(ctx),
		state: () => readState(ctx),
	};
}
