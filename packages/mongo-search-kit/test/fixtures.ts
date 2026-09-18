import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { bindIndex, defineIndex } from '@nxgt/meilisearch';
import {
	closeMongo,
	defineCollection,
	id,
	type ReadDocumentOf,
} from '@nxgt/mongo';
import { createKit, defineConfig, type KitOf } from '@nxgt/mongo-kit';
import { z } from 'zod';
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

/** A second collection, so the kit has more than one sync to hold. */
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
export const toArticleHit = (article: Article): ArticleHit | null =>
	article.draft ? null : { id: String(article._id), title: article.title };

export const toAuthorHit = (author: Author): AuthorHit => ({
	id: String(author._id),
	name: author.name,
});

const collections = { articles, authors };

export type Kit = KitOf<ReturnType<typeof kitConfig>>;

const kitConfig = (uri: string) => defineConfig({ uri, collections });

export interface Servers {
	mongo: Mongo;
	meili: Meili;
	kit: Kit;
}

/**
 * Both servers and one kit per spec file, everything emptied before each
 * test. The kit is the caller's to build search kits over.
 */
export function useServers(name: string) {
	const servers = {} as Servers;

	beforeAll(async () => {
		[servers.mongo, servers.meili] = await Promise.all([
			startMongo(name),
			startMeilisearch(),
		]);
		servers.kit = await createKit(kitConfig(servers.mongo.uri));
	}, 120_000);

	beforeEach(async () => {
		await servers.mongo.clearFailures();
		await Promise.all([servers.mongo.reset(), servers.meili.reset()]);
		// The drop took the indexes with it, and `autoSync` runs once per
		// collection and per process — so the kit syncs them again itself.
		await servers.kit.sync();
	});

	afterAll(async () => {
		await servers.kit?.close();
		await closeMongo();
		await Promise.all([servers.mongo?.stop(), servers.meili?.stop()]);
	});

	/** The two indexes, bound to this file's Meilisearch. */
	const indexes = () => ({
		articles: bindIndex(servers.meili.client, articleIndex),
		authors: bindIndex(servers.meili.client, authorIndex),
	});

	/** What an index holds, id → its searchable field, sorted by id. */
	const rowsOf = async <T extends { id: string }>(
		read: () => Promise<{ results: T[] }>,
		field: (hit: T) => string,
	) => {
		const page = await read().catch((error: { cause?: { code?: string } }) => {
			if (error.cause?.code === 'index_not_found')
				return { results: [] as T[] };
			throw error;
		});
		const rows = page.results.map((hit) => [hit.id, field(hit)] as const);
		return Object.fromEntries(rows.sort(([a], [b]) => a.localeCompare(b)));
	};

	const indexedArticles = () =>
		rowsOf(
			() => indexes().articles.list({ limit: 1000 }),
			(hit) => hit.title,
		);

	const indexedAuthors = () =>
		rowsOf(
			() => indexes().authors.list({ limit: 1000 }),
			(hit) => hit.name,
		);

	return { servers, indexes, indexedArticles, indexedAuthors };
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
