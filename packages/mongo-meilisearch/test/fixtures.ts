import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { bindIndex, defineIndex } from '@nxgt/meilisearch';
import {
	closeMongo,
	defineCollection,
	defineMongo,
	id,
	type MongoOf,
	openMongo,
	type ReadDocumentOf,
} from '@nxgt/mongo';
import { z } from 'zod';
import { createSearchSync } from '../src';
import type { RunningSearchSync, SearchSyncOptions } from '../src/sync/types';
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

/** A second collection, so a search over several has more than one sync. */
export const authors = defineCollection({
	name: 'authors',
	schema: z.object({ _id: id(), name: z.string() }),
});

export type Article = ReadDocumentOf<typeof articles>;
export type Author = ReadDocumentOf<typeof authors>;

export interface ArticleHit {
	id: string;
	title: string;
}
export interface AuthorHit {
	id: string;
	name: string;
}

export const articleIndex = defineIndex<ArticleHit>()({
	uid: 'articles',
	primaryKey: 'id',
	settings: { searchableAttributes: ['title'] },
});

export const authorIndex = defineIndex<AuthorHit>()({
	uid: 'authors',
	primaryKey: 'id',
	settings: { searchableAttributes: ['name'] },
});

/** Drafts stay out of the index. */
export const toHit = (article: Article): ArticleHit | null =>
	article.draft ? null : { id: String(article._id), title: article.title };

export const toAuthorHit = (author: Author): AuthorHit => ({
	id: String(author._id),
	name: author.name,
});

const wiringOf = (uri: string) =>
	defineMongo({ uri, collections: { articles, authors } });

/** What `openMongo` gives over the two collections. */
export type Wired = MongoOf<ReturnType<typeof wiringOf>>;

export interface Servers {
	mongo: Mongo;
	meili: Meili;
	/** Opened once per spec file: what a search over several collections takes. */
	wired: Wired;
}

/**
 * Both servers and one `openMongo` result, one each per spec file, emptied
 * before every test; and the running syncs a test opened, closed after it.
 */
export function useServers(name: string) {
	const servers = {} as Servers;
	const running: RunningSearchSync[] = [];
	beforeAll(async () => {
		[servers.mongo, servers.meili] = await Promise.all([
			startMongo(name),
			startMeilisearch(),
		]);
		servers.wired = await openMongo(wiringOf(servers.mongo.uri));
	}, 120_000);
	beforeEach(async () => {
		await Promise.all(running.splice(0).map((r) => r.close().catch(() => {})));
		await servers.mongo.clearFailures();
		await Promise.all([servers.mongo.reset(), servers.meili.reset()]);
		// The drop took the indexes with it, and `autoSync` runs once per
		// collection and per process, so they are synced again here.
		await servers.wired.sync();
	});
	afterAll(async () => {
		await Promise.all(running.splice(0).map((r) => r.close().catch(() => {})));
		await servers.wired?.close();
		await closeMongo();
		await Promise.all([servers.mongo?.stop(), servers.meili?.stop()]);
	});

	const collection = () => servers.wired.db.articles;
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
	/**
	 * Closes this sync after the test, and takes the rejection `closed` ends
	 * with when the servers stop under a sync still running: nobody would be
	 * waiting for it then, and Bun counts an unhandled rejection as an error.
	 */
	const track = (r: RunningSearchSync) => {
		running.push(r);
		r.closed.catch(() => undefined);
		return r;
	};
	/** Starts a sync, and closes it after the test. */
	const start = async (options?: Parameters<typeof sync>[0]) =>
		track(await sync(options).start());
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

	/** The two indexes, bound to this file's Meilisearch. */
	const indexes = () => ({
		articles: index(),
		authors: bindIndex(servers.meili.client, authorIndex),
	});
	/** What the authors index holds, id → name. */
	const indexedAuthors = async () => {
		const page = await indexes()
			.authors.list({ limit: 1000 })
			.catch((error: { cause?: { code?: string } }) => {
				if (error.cause?.code === 'index_not_found') return { results: [] };
				throw error;
			});
		return Object.fromEntries(
			byId(page.results.map((hit) => [hit.id, hit.name] as const)),
		);
	};
	/** What the articles index holds, id → title. */
	const indexedArticles = async () => Object.fromEntries(await indexed());
	return {
		servers,
		collection,
		index,
		indexes,
		sync,
		start,
		track,
		indexed,
		indexedArticles,
		indexedAuthors,
	};
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
