import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { createRepository, type Row } from '@nxgt/drizzle/pg';
import { bindIndex, defineIndex } from '@nxgt/meilisearch';
import { createSearchSync } from '../src';
import type { SearchSyncOptions } from '../src/types';
import { createTestDb } from './db';
import { type TestServer as Meili, startMeilisearch } from './meilisearch';
import { articles } from './schema';

export type Article = Row<typeof articles>;

export interface ArticleHit {
	id: string;
	title: string;
}

export const articleIndex = defineIndex<ArticleHit>()({
	uid: 'articles',
	primaryKey: 'id',
	settings: { searchableAttributes: ['title'] },
});

/** Drafts stay out of the index. */
export const toHit = (article: Article): ArticleHit | null =>
	article.draft ? null : { id: article.id, title: article.title };

export const toIndexId = (article: Article) => article.id;

type Db = Awaited<ReturnType<typeof createTestDb>>;

/**
 * PGlite and a Meilisearch, one each per spec file, emptied before every
 * test.
 */
export function useServers() {
	const state = {} as { db: Db; meili: Meili };
	beforeAll(async () => {
		[state.db, state.meili] = await Promise.all([
			createTestDb(),
			startMeilisearch(),
		]);
	}, 120_000);
	beforeEach(async () => {
		await Promise.all([state.db.reset(), state.meili.reset()]);
	});
	afterAll(async () => {
		await Promise.all([state.db?.close(), state.meili?.stop()]);
	});

	const repository = () => createRepository(state.db.db, articles);
	const index = () => bindIndex(state.meili.client, articleIndex);
	const sync = (
		options: Partial<
			SearchSyncOptions<typeof articles, typeof articleIndex>
		> = {},
	) =>
		createSearchSync({
			repository: repository(),
			index: index(),
			transform: toHit,
			toIndexId,
			...options,
		});
	/** What the index holds, by id, as `[id, title]` pairs sorted by id. */
	const indexed = async () => {
		const page = await index()
			.list({ limit: 1000 })
			.catch((error: { cause?: { code?: string } }) => {
				if (error.cause?.code === 'index_not_found') return { results: [] };
				throw error;
			});
		return page.results
			.map((hit) => [hit.id, hit.title] as const)
			.sort((a, b) => a[0].localeCompare(b[0]));
	};
	return { state, repository, index, sync, indexed };
}

/** Polls `read` until it gives what `expected` is, or fails after a while. */
export async function eventually<T>(
	read: () => Promise<T>,
	expected: T,
): Promise<void> {
	const deadline = Date.now() + 15_000;
	for (;;) {
		const value = await read();
		if (Bun.deepEquals(value, expected)) return;
		if (Date.now() > deadline) {
			throw new Error(
				`Timed out waiting for ${JSON.stringify(expected)}, last read ${JSON.stringify(value)}`,
			);
		}
		await Bun.sleep(50);
	}
}
