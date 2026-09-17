import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { bindIndex, defineIndex } from '@nxgt/meilisearch';
import {
	defineCollection,
	getCollection,
	id,
	type ReadDocumentOf,
} from '@nxgt/mongo';
import { z } from 'zod';
import { createSearchSync } from '../src';
import type { RunningSearchSync, SearchSyncOptions } from '../src/types';
import { type TestServer as Meili, startMeilisearch } from './meilisearch';
import { type TestServer as Mongo, startMongo } from './mongo';

/** Soft-deleted, stamped, and with a flag the transform keeps out on. */
export const articles = defineCollection({
	name: 'articles',
	schema: z.object({
		_id: id(),
		title: z.string(),
		draft: z.boolean().default(false),
	}),
	timestamps: true,
	softDelete: true,
});

export type Article = ReadDocumentOf<typeof articles>;

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
	article.draft ? null : { id: String(article._id), title: article.title };

export interface Servers {
	mongo: Mongo;
	meili: Meili;
}

/**
 * Both servers, one each per spec file, emptied before every test; and the
 * running syncs a test opened, closed after it.
 */
export function useServers(name: string) {
	const servers = {} as Servers;
	const running: RunningSearchSync[] = [];
	beforeAll(async () => {
		[servers.mongo, servers.meili] = await Promise.all([
			startMongo(name),
			startMeilisearch(),
		]);
	}, 120_000);
	beforeEach(async () => {
		await Promise.all(running.splice(0).map((r) => r.close().catch(() => {})));
		await servers.mongo.clearFailures();
		await Promise.all([servers.mongo.reset(), servers.meili.reset()]);
		await getCollection(servers.mongo.db, articles).sync();
	});
	afterAll(async () => {
		await Promise.all(running.splice(0).map((r) => r.close().catch(() => {})));
		await Promise.all([servers.mongo?.stop(), servers.meili?.stop()]);
	});

	const collection = () => getCollection(servers.mongo.db, articles);
	const index = () => bindIndex(servers.meili.client, articleIndex);
	const sync = (
		options: Partial<
			SearchSyncOptions<typeof articles, typeof articleIndex>
		> = {},
	) =>
		createSearchSync({
			collection: collection(),
			index: index(),
			transform: toHit,
			flushIntervalMs: 20,
			...options,
		});
	/** Starts a sync, and closes it after the test. */
	const start = async (options?: Parameters<typeof sync>[0]) => {
		const r = await sync(options).start();
		running.push(r);
		return r;
	};
	/** What the index holds, sorted by id. */
	const indexed = async () => {
		const page = await index()
			.list({ limit: 1000 })
			.catch((error: { cause?: { code?: string } }) => {
				if (error.cause?.code === 'index_not_found') return { results: [] };
				throw error;
			});
		return byId(page.results.map((hit) => [hit.id, hit.title] as const));
	};
	return { servers, collection, index, sync, start, indexed };
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
				`still ${JSON.stringify(value)}, not ${JSON.stringify(expected)}`,
			);
		}
		await Bun.sleep(50);
	}
}

type Row = readonly [id: string, title: string];

/** Rows of the index, sorted as `indexed` gives them. */
export const byId = (rows: Row[]): Row[] =>
	[...rows].sort(([a], [b]) => a.localeCompare(b));
