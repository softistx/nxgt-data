import { describe, expect, test } from 'bun:test';
import { createKit, defineConfig } from '@nxgt/mongo-kit';
import type { SearchSync } from '@nxgt/mongo-meilisearch';
import {
	type Article,
	articles,
	authors,
	eventually,
	toArticleHit,
	toAuthorHit,
	useServers,
} from '../../test/fixtures';
import { createSearchKit } from './create-search-kit';

const { servers, indexes, indexedArticles, indexedAuthors } =
	useServers('search-kit');

/** The whole config, both collections, with a short flush for the specs. */
const both = () => {
	const bound = indexes();
	return {
		articles: {
			index: bound.articles,
			transform: toArticleHit,
			flushIntervalMs: 20,
		},
		authors: {
			index: bound.authors,
			transform: toAuthorHit,
			flushIntervalMs: 20,
		},
	} as const;
};

/** The same two, but nothing is sent until something asks for it. */
const held = () => {
	const bound = indexes();
	return {
		articles: {
			index: bound.articles,
			transform: toArticleHit,
			flushIntervalMs: 60_000,
		},
		authors: {
			index: bound.authors,
			transform: toAuthorHit,
			flushIntervalMs: 60_000,
		},
	} as const;
};

/** A transform that falls over on one title, and works otherwise. */
const throwsOn = (bad: string) => (article: Article) =>
	article.title === bad
		? (() => {
				throw new Error(bad);
			})()
		: { id: String(article._id), title: article.title };

describe('a search kit', () => {
	test('builds one sync per entry, under the config’s own keys', () => {
		const search = createSearchKit(servers.kit, both());
		expect(Object.keys(search.syncs)).toEqual(['articles', 'authors']);
		expect(search.syncs.articles.name).toBe('articles:articles');
		expect(search.syncs.authors.name).toBe('authors:authors');
	});

	test('syncs every index, reports each under its key, and a second run sends nothing', async () => {
		const search = createSearchKit(servers.kit, both());

		const dry = await search.syncIndexes({ dryRun: true });
		expect(Object.keys(dry)).toEqual(['articles', 'authors']);
		expect(dry.articles).toMatchObject({ uid: 'articles', created: true });
		expect(
			(await servers.meili.client.getIndexes()).results.map((it) => it.uid),
		).toEqual([]);

		const first = await search.syncIndexes();
		expect(first.articles).toMatchObject({ created: true, dryRun: false });
		expect(first.authors.changed).toContain('searchableAttributes');
		expect(
			(await servers.meili.client.index('authors').getSettings())
				.searchableAttributes,
		).toEqual(['name']);

		const second = await search.syncIndexes();
		expect(second.articles).toMatchObject({ created: false, changed: [] });
		expect(second.authors).toMatchObject({ created: false, changed: [] });
	});

	test('syncIndexes stops at the first index that throws', async () => {
		// `articles` exists under another primary key, which no sync can fix.
		await servers.meili.client
			.createIndex('articles', { primaryKey: 'slug' })
			.waitTask();
		const held = createSearchKit(servers.kit, both())
			.syncIndexes()
			.then(
				() => {
					throw new Error('syncIndexes resolved');
				},
				(error: unknown) => error,
			);
		const error = (await held) as { code?: string };
		expect(error.code).toBe('PRIMARY_KEY_MISMATCH');
		expect(
			(await servers.meili.client.getIndexes()).results.map((it) => it.uid),
		).toEqual(['articles']);
	});

	test('reindexes every collection, and reports each under its key', async () => {
		await servers.kit.db.articles.create({ title: 'one' });
		await servers.kit.db.articles.create({ title: 'two', draft: true });
		await servers.kit.db.authors.create({ name: 'ada' });

		const reports = await createSearchKit(servers.kit, both()).reindexAll();

		expect(reports.articles).toMatchObject({ indexed: 1, skipped: 1 });
		expect(reports.authors).toMatchObject({ indexed: 1, skipped: 0 });
		expect(Object.values(await indexedArticles())).toEqual(['one']);
		expect(Object.values(await indexedAuthors())).toEqual(['ada']);
	});

	test('follows both collections at once, from one start', async () => {
		const search = createSearchKit(servers.kit, both());
		await search.reindexAll();
		await using running = await search.start();
		running.failed.catch(() => undefined);

		await servers.kit.db.articles.create({ title: 'written' });
		await servers.kit.db.authors.create({ name: 'grace' });

		await eventually(
			async () => Object.values(await indexedArticles()),
			['written'],
		);
		await eventually(
			async () => Object.values(await indexedAuthors()),
			['grace'],
		);
	});

	test('answers where each sync stands', async () => {
		const search = createSearchKit(servers.kit, both());
		expect(await search.state()).toEqual({
			articles: undefined,
			authors: undefined,
		});
		await search.reindexAll();
		const state = await search.state();
		expect(state.articles?.reindexedAt).toBeInstanceOf(Date);
		expect(state.authors?.reindexedAt).toBeInstanceOf(Date);
	});

	test('closes what it started when a later sync will not start', async () => {
		const search = createSearchKit(servers.kit, both());
		await search.reindexAll();
		// The second entry is already following, so starting it again is
		// refused — and the first must not be left running.
		const held = await search.syncs.authors.start();
		held.closed.catch(() => undefined);
		try {
			await expect(search.start()).rejects.toThrow();
			// The articles sync was started first; nothing of this kit is left
			// following, so a fresh kit may start it.
			const again = createSearchKit(servers.kit, {
				articles: both().articles,
			});
			await using running = await again.start();
			running.failed.catch(() => undefined);
			expect(Object.keys(running.running)).toEqual(['articles']);
		} finally {
			await held.close();
		}
	});

	test('closing twice is closing once', async () => {
		const search = createSearchKit(servers.kit, both());
		await search.reindexAll();
		const running = await search.start();
		running.failed.catch(() => undefined);
		await running.close();
		await running.close();
		expect(Object.keys(running.running)).toEqual(['articles', 'authors']);
	});

	test('failed rejects with the sync that fell over', async () => {
		const bound = indexes();
		const search = createSearchKit(servers.kit, {
			articles: {
				index: bound.articles,
				flushIntervalMs: 20,
				transform: (article) => {
					if (article.title === 'bad') throw new Error('boom');
					return { id: String(article._id), title: article.title };
				},
			},
			authors: {
				index: bound.authors,
				transform: toAuthorHit,
				flushIntervalMs: 20,
			},
		});
		await search.reindexAll();
		const running = await search.start();
		try {
			await servers.kit.db.articles.create({ title: 'bad' });
			const error = (await running.failed.catch(
				(reason: unknown) => reason,
			)) as {
				code?: string;
				sync?: string;
				cause?: unknown;
			};
			expect(error.code).toBe('FAILED');
			expect(error.sync).toBe('articles:articles');
			expect((error.cause as Error).message).toBe('boom');
			// `failed` reported it; `close` does not report it again.
			await expect(running.close()).resolves.toBeUndefined();
		} finally {
			await running.close();
		}
	});

	test('failed does not settle when the kit is closed cleanly', async () => {
		const search = createSearchKit(servers.kit, both());
		await search.reindexAll();
		const running = await search.start();
		running.failed.catch(() => undefined);
		await running.close();
		// A clean stop is not an event to wait for: only a failure settles it.
		const settled = await Promise.race([
			running.failed.then(
				() => 'resolved',
				() => 'rejected',
			),
			Bun.sleep(150).then(() => 'pending'),
		]);
		expect(settled).toBe('pending');
	});

	test('flushes every sync, not just the ones before a failure', async () => {
		const search = createSearchKit(servers.kit, held());
		await search.reindexAll();
		await using running = await search.start();
		running.failed.catch(() => undefined);

		await servers.kit.db.articles.create({ title: 'held' });
		await servers.kit.db.authors.create({ name: 'kept' });
		// Nothing has been sent: the interval is a minute away.
		await Bun.sleep(200);
		expect(Object.values(await indexedArticles())).toEqual([]);

		await running.flush();

		expect(Object.values(await indexedArticles())).toEqual(['held']);
		expect(Object.values(await indexedAuthors())).toEqual(['kept']);
	});

	test('takes each sync’s closed as it starts, not once all have', async () => {
		// A later `start` reindexes when its key has nothing recorded, and the
		// syncs before it are already following. A failure in that window used
		// to reject with nobody listening, which ends the process — so this
		// spec fails by killing the run, not by an assertion.
		const bound = indexes();
		const search = createSearchKit(servers.kit, {
			articles: {
				index: bound.articles,
				flushIntervalMs: 20,
				transform: throwsOn('bad'),
			},
			authors: {
				index: bound.authors,
				transform: toAuthorHit,
				flushIntervalMs: 20,
			},
		});
		await search.syncs.articles.reindex();

		// `search.syncs` is the object `start` reads, so wrapping the second
		// entry puts the failure exactly inside the window.
		const real = search.syncs.authors;
		(search.syncs as Record<string, SearchSync>).authors = {
			...real,
			start: async () => {
				await servers.kit.db.articles.create({ title: 'bad' });
				await Bun.sleep(400);
				return real.start();
			},
		} as SearchSync;

		const running = await search.start();
		running.failed.catch(() => undefined);
		await running.close();
	});

	test('close throws a failure that failed could no longer carry', async () => {
		const bound = indexes();
		const search = createSearchKit(servers.kit, {
			articles: {
				index: bound.articles,
				flushIntervalMs: 20,
				transform: throwsOn('bad'),
			},
			authors: {
				index: bound.authors,
				flushIntervalMs: 20,
				transform: (author) =>
					author.name === 'worse'
						? (() => {
								throw new Error('worse');
							})()
						: { id: String(author._id), name: author.name },
			},
		});
		await search.reindexAll();
		const running = await search.start();

		// The first failure is the one `failed` reports.
		await servers.kit.db.articles.create({ title: 'bad' });
		const first = (await running.failed.catch((reason: unknown) => reason)) as {
			sync?: string;
		};
		expect(first.sync).toBe('articles:articles');

		// The second settles nothing: `failed` is spent. `close` is what is
		// left to say it, so it must not swallow this one too.
		await servers.kit.db.authors.create({ name: 'worse' });
		await eventually(
			async () =>
				running.running.authors.closed.then(
					() => 'clean',
					() => 'stopped',
				),
			'stopped',
		);
		await expect(running.close()).rejects.toThrow('worse');
	});

	test('refuses a key the kit wires no collection for', () => {
		expect(() =>
			createSearchKit(servers.kit, {
				// @ts-expect-error the kit wires no `comments`
				comments: { index: indexes().articles, transform: toArticleHit },
			}),
		).toThrow('wires no collection called "comments"');
	});

	test('refuses a key that is a member of the driver’s Db', () => {
		expect(() =>
			createSearchKit(servers.kit, {
				// @ts-expect-error `command` is the driver's, not a collection
				command: { index: indexes().articles, transform: toArticleHit },
			}),
		).toThrow('wires no collection called "command"');
	});

	test('refuses a kit that holds more than one database', async () => {
		const many = await createKit(
			defineConfig({
				databases: {
					main: { uri: servers.mongo.uri, collections: { articles } },
					other: {
						uri: servers.mongo.uri,
						database: 'other',
						collections: { authors },
					},
				},
			}),
		);
		try {
			expect(() =>
				// @ts-expect-error `SoleCollections` is `never` for such a kit
				createSearchKit(many, { articles: { index: indexes().articles } }),
			).toThrow('holds 2 databases');
		} finally {
			await many.close();
		}
	});
});
