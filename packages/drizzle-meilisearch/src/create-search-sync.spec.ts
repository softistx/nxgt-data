import { describe, expect, test } from 'bun:test';
import { articleIndex } from '../test/fixtures';
import { articles } from '../test/schema';
import { createSearchSync } from './create-search-sync';
import type { SearchSyncOptions, SyncRepository } from './types';

/**
 * No PostgreSQL and no Meilisearch: `createSearchSync` does no I/O, so what
 * it refuses can be measured on a repository and an index that are only
 * their shapes.
 */
const repository = {
	table: articles,
	paginateByCursor: async () => ({ items: [], nextCursor: null }),
} as unknown as SyncRepository<typeof articles>;

const index = {
	uid: 'articles',
	definition: articleIndex,
} as unknown as SearchSyncOptions<
	typeof articles,
	typeof articleIndex
>['index'];

const options = {
	repository,
	index,
	transform: (row: { id: string; title: string }) => ({
		id: row.id,
		title: row.title,
	}),
	toIndexId: (row: { id: string }) => row.id,
} as unknown as SearchSyncOptions<typeof articles, typeof articleIndex>;

const withOptions = (patch: Record<string, unknown>) =>
	createSearchSync({ ...options, ...patch });

describe('createSearchSync', () => {
	test('names the sync after the table and the index', () => {
		expect(createSearchSync(options).name).toBe('articles:articles');
	});

	test('takes a name of its own', () => {
		expect(withOptions({ name: 'blog' }).name).toBe('blog');
	});

	test('refuses an empty name', () => {
		expect(() => withOptions({ name: '' })).toThrow(
			'createSearchSync: name must not be empty',
		);
	});

	test('refuses a transform that is not a function', () => {
		expect(() => withOptions({ transform: undefined })).toThrow(
			'createSearchSync: transform must be a function',
		);
	});

	test('refuses a toIndexId that is not a function', () => {
		// Where the Mongo bridge defaults it to `String`: no column here is
		// known to be the primary key, so nothing could be defaulted to.
		expect(() => withOptions({ toIndexId: undefined })).toThrow(
			'createSearchSync: toIndexId must be a function',
		);
	});

	test('refuses a batchSize that is not a whole number above 0', () => {
		expect(() => withOptions({ batchSize: 0 })).toThrow(
			'createSearchSync: batchSize must be a whole number above 0, not 0',
		);
		expect(() => withOptions({ pageSize: 1.5 })).toThrow(
			'createSearchSync: pageSize must be a whole number above 0, not 1.5',
		);
	});

	test('refuses a pageSize given to reindexAll, and says which call', async () => {
		const sync = createSearchSync(options);
		await expect(sync.reindexAll({ pageSize: -1 })).rejects.toThrow(
			'reindexAll on "articles:articles": pageSize must be a whole number ' +
				'above 0, not -1',
		);
	});

	test('sends nothing for no rows', async () => {
		const sync = createSearchSync(options);
		// The index above would throw on any call: that none of these reaches
		// it is what says an empty write is not a round trip.
		await sync.indexRows([]);
		await sync.removeMany([]);
	});
});
