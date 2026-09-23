import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { Meilisearch, MeilisearchApiError } from 'meilisearch';
import { type Movie, movies, sampleMovies } from '../../test/movies';
import { startMeilisearch, type TestServer } from '../../test/server';
import { SearchIndexError } from '../errors/search-index-error';
import { bindIndex } from '../index/bind-index';
import { tenantToken } from '../token/tenant-token';

let t: TestServer;

beforeAll(async () => {
	t = await startMeilisearch();
}, 60_000);
beforeEach(() => t.reset());
afterAll(() => t.stop());

/** The same movies, retitled: what a rebuild writes instead of the old ones. */
const remade: Movie[] = sampleMovies.map((m) => ({
	...m,
	title: `${m.title} (remastered)`,
}));

const uids = async () =>
	(await t.client.getRawIndexes()).results.map((index) => index.uid).sort();

const titles = async (uid = 'movies') =>
	(await t.client.index(uid).search('', { sort: ['year:asc'] })).hits.map(
		(hit) => hit.title,
	);

/** The live index, synced and holding the sample movies. */
async function live() {
	const index = bindIndex(t.client, movies);
	await index.sync();
	await index.add(sampleMovies, { wait: true });
	return index;
}

describe('rebuild', () => {
	test('a search during the rebuild sees the old documents, and after it the new ones', async () => {
		const index = await live();
		const before = await titles();
		const during: string[][] = [];

		const report = await index.rebuild(async (next) => {
			expect(next.uid).toBe('movies_next');
			during.push(await titles());
			await next.add(remade, { wait: true });
			// Filled, and not swapped yet: the live index still holds the old ones.
			during.push(await titles());
			expect(await titles('movies_next')).toEqual(remade.map((m) => m.title));
		});

		expect(during).toEqual([before, before]);
		expect(await titles()).toEqual(remade.map((m) => m.title));
		expect(await uids()).toEqual(['movies']);
		expect(report.created).toBe(false);
		expect(report.leftoverDeleted).toBe(false);
		expect(report.tasks.map((task) => [task.type, task.status])).toEqual([
			['indexSwap', 'succeeded'],
			['indexDeletion', 'succeeded'],
		]);
	});

	test('the swapped-in index has the definition’s settings: it still filters and sorts', async () => {
		const index = await live();
		await index.rebuild((next) =>
			next.add(remade, { wait: true }).then(() => undefined),
		);
		const result = await index.search('', {
			filter: 'genres = scifi',
			sort: ['year:desc'],
			facets: ['genres'],
		});
		expect(result.hits.map((m) => m.id)).toEqual([4, 2, 1]);
		expect(result.facetDistribution?.genres?.scifi).toBe(3);
		const settings = await t.client.index('movies').getSettings();
		expect(settings.filterableAttributes?.slice().sort()).toEqual([
			'director.name',
			'genres',
			'year',
		]);
		// A sync right after finds nothing to change.
		expect((await index.sync()).tasks).toEqual([]);
	});

	test('the first run, with no live index, renames the next one', async () => {
		const index = bindIndex(t.client, movies);
		const report = await index.rebuild(async (next) => {
			await next.add(remade, { wait: true });
		});
		expect(report.created).toBe(true);
		expect(report.tasks.map((task) => [task.type, task.status])).toEqual([
			['indexSwap', 'succeeded'],
		]);
		expect(await uids()).toEqual(['movies']);
		expect((await t.client.getRawIndex('movies')).primaryKey).toBe('id');
		expect(await titles()).toEqual(remade.map((m) => m.title));
		expect(
			(await index.search('', { filter: 'year > 1990' })).hits.length,
		).toBe(2);
	});

	test('a next index left by a crashed run is deleted first', async () => {
		const index = await live();
		// Another primary key, so a sync onto it would throw PRIMARY_KEY_MISMATCH.
		await t.client
			.createIndex('movies_next', { primaryKey: 'title' })
			.waitTask();
		await t.client
			.index('movies_next')
			.addDocuments([{ title: 'leftover' }])
			.waitTask();

		const report = await index.rebuild(async (next) => {
			await next.add(remade, { wait: true });
		});
		expect(report.leftoverDeleted).toBe(true);
		expect(await titles()).toEqual(remade.map((m) => m.title));
		expect(await uids()).toEqual(['movies']);
	});

	test('a rebuild changes the primary key of a live index, which sync cannot', async () => {
		await t.client.createIndex('movies', { primaryKey: 'title' }).waitTask();
		const index = bindIndex(t.client, movies);
		await index.rebuild(async (next) => {
			await next.add(sampleMovies, { wait: true });
		});
		expect((await t.client.getRawIndex('movies')).primaryKey).toBe('id');
	});

	test('a fill that throws deletes the next index, leaves the live one, and throws REBUILD_FAILED', async () => {
		const index = await live();
		const before = await titles();
		const boom = new Error('the source database went away');
		const error = await index
			.rebuild(async (next) => {
				await next.add(remade.slice(0, 2), { wait: true });
				throw boom;
			})
			.catch((e) => e);
		expect(error).toBeInstanceOf(SearchIndexError);
		expect(error.code).toBe('REBUILD_FAILED');
		expect(error.indexUid).toBe('movies');
		expect(error.cause).toBe(boom);
		expect(error.message).toBe(
			'Rebuild of index "movies" stopped while filling "movies_next": ' +
				'"movies_next" was deleted, and "movies" is as it was. The cause is on `cause`.',
		);
		expect(await uids()).toEqual(['movies']);
		expect(await titles()).toEqual(before);
	});

	test('a write the fill only enqueued, and that failed, stops the swap', async () => {
		const index = await live();
		const before = await titles();
		const bad = { ...remade[0], id: 'not an id' } as unknown as Movie;
		const error = await index
			.rebuild(async (next) => {
				await next.add(remade.slice(1));
				await next.add([bad]); // enqueued, not waited for
			})
			.catch((e) => e);
		expect(error).toBeInstanceOf(SearchIndexError);
		expect(error.code).toBe('REBUILD_FAILED');
		expect(error.cause).toBeInstanceOf(SearchIndexError);
		expect(error.cause.code).toBe('TASK_FAILED');
		expect(error.task.type).toBe('documentAdditionOrUpdate');
		expect(error.task.error.code).toBe('invalid_document_id');
		expect(error.task.indexUid).toBe('movies_next');
		expect(await uids()).toEqual(['movies']);
		expect(await titles()).toEqual(before);
	});

	test('nextUid names the index filled beside the live one', async () => {
		const index = await live();
		const report = await index.rebuild(
			async (next) => {
				expect(next.uid).toBe('movies_building');
				await next.add(remade);
			},
			{ nextUid: 'movies_building' },
		);
		expect(report.nextUid).toBe('movies_building');
		expect(await uids()).toEqual(['movies']);
		expect(await titles()).toEqual(remade.map((m) => m.title));
	});

	describe('with a key that is not the master key', () => {
		const actions = [
			'indexes.create',
			'indexes.get',
			'indexes.update',
			'indexes.swap',
			'indexes.delete',
			'settings.get',
			'settings.update',
			'tasks.get',
			'documents.add',
		];
		/** A client on a new key; the key itself is never printed. */
		const clientWith = async (indexes: string[], without: string[] = []) => {
			const { key } = await t.client.createKey({
				actions: actions.filter((action) => !without.includes(action)),
				indexes,
				expiresAt: null,
			});
			return new Meilisearch({ host: t.host, apiKey: key });
		};

		test('a key on every index rebuilds', async () => {
			await live();
			const client = await clientWith(['*']);
			await bindIndex(client, movies).rebuild(async (next) => {
				await next.add(remade);
			});
			expect(await titles()).toEqual(remade.map((m) => m.title));
			expect(await uids()).toEqual(['movies']);
		});

		test.each([[['movies', 'movies_next']], [['movies*']]])(
			'a key on %p cannot wait for the swap, which still happens',
			async (indexes) => {
				await live();
				const client = await clientWith(indexes);
				const error = await bindIndex(client, movies)
					.rebuild(async (next) => {
						await next.add(remade);
					})
					.catch((e) => e);
				expect(error).toBeInstanceOf(SearchIndexError);
				expect(error.code).toBe('REBUILD_FAILED');
				expect(error.message).toBe(
					'Rebuild of index "movies" sent the swap with "movies_next" and could not wait for it: ' +
						'whether "movies" was swapped is unknown, and "movies_next" was left for the next rebuild to delete. ' +
						'The cause is on `cause`.',
				);
				// The swap task has no index, and a key on named indexes cannot read it.
				expect(error.cause).toBeInstanceOf(MeilisearchApiError);
				expect(error.cause.cause.code).toBe('task_not_found');
				expect(error.cause.message).toMatch(/^Task `\d+` not found\.$/);
				// The wait failed at its first poll, so the swap may still be running:
				// the master key can read it. It happened: the new documents are live,
				// and the old ones are left over.
				const tasks = await t.client.tasks.getTasks({ types: ['indexSwap'] });
				const swap = tasks.results[0];
				if (!swap) throw new Error('no swap task');
				expect((await t.client.tasks.waitForTask(swap.uid)).status).toBe(
					'succeeded',
				);
				expect(await titles()).toEqual(remade.map((m) => m.title));
				expect(await uids()).toEqual(['movies', 'movies_next']);
			},
		);

		test('a key that may not change settings stops while creating, and leaves nothing behind', async () => {
			await live();
			const before = await titles();
			const client = await clientWith(['*'], ['settings.update']);
			const error = await bindIndex(client, movies)
				.rebuild(async () => {
					throw new Error('fill must not run');
				})
				.catch((e) => e);
			expect(error).toBeInstanceOf(SearchIndexError);
			expect(error.code).toBe('REBUILD_FAILED');
			expect(error.message).toBe(
				'Rebuild of index "movies" stopped while creating "movies_next": ' +
					'"movies_next" was deleted, and "movies" is as it was. The cause is on `cause`.',
			);
			expect(error.cause).toBeInstanceOf(MeilisearchApiError);
			expect(error.cause.cause.code).toBe('invalid_api_key');
			expect(error.cause.message).toBe('The provided API key is invalid.');
			expect(await uids()).toEqual(['movies']);
			expect(await titles()).toEqual(before);
		});

		test('a key that may not delete indexes says so when a rebuild stops, and leaves the next index', async () => {
			await live();
			const before = await titles();
			const client = await clientWith(['*'], ['indexes.delete']);
			const boom = new Error('the source database went away');
			const error = await bindIndex(client, movies)
				.rebuild(async (next) => {
					await next.add(remade, { wait: true });
					throw boom;
				})
				.catch((e) => e);
			expect(error).toBeInstanceOf(SearchIndexError);
			expect(error.code).toBe('REBUILD_FAILED');
			expect(error.cause).toBe(boom);
			expect(error.message).toBe(
				'Rebuild of index "movies" stopped while filling "movies_next": ' +
					'"movies_next" could not be deleted; the next rebuild deletes it first, ' +
					'and "movies" is as it was. The cause is on `cause`.',
			);
			expect(await uids()).toEqual(['movies', 'movies_next']);
			expect(await titles()).toEqual(before);
		});

		test('a key that may not delete indexes swaps, then throws the SDK’s error unwrapped', async () => {
			await live();
			const client = await clientWith(['*'], ['indexes.delete']);
			const error = await bindIndex(client, movies)
				.rebuild(async (next) => {
					await next.add(remade);
				})
				.catch((e) => e);
			expect(error).toBeInstanceOf(MeilisearchApiError);
			expect(error.cause.code).toBe('invalid_api_key');
			// The swap happened: the new documents are live, the old ones left over.
			expect(await titles()).toEqual(remade.map((m) => m.title));
			expect(await uids()).toEqual(['movies', 'movies_next']);
		});
	});

	test('fill’s index has the next uid, and a token rule under the live uid is refused', async () => {
		const index = await live();
		const key = await t.client.createKey({
			actions: ['search'],
			indexes: ['movies', 'movies_next'],
			expiresAt: null,
		});
		let refused: unknown;
		await index.rebuild(async (next) => {
			expect(next.definition.uid).toBe('movies_next');
			refused = await tenantToken({
				apiKey: key.key,
				apiKeyUid: key.uid,
				indexes: [next],
				searchRules: { movies: { filter: 'genres = scifi' } },
			}).catch((e) => e);
			await next.add(remade);
		});
		expect(refused).toBeInstanceOf(TypeError);
		expect((refused as Error).message).toBe(
			'tenantToken for "movies_next": searchRules names "movies", which is not the uid of any of its indexes',
		);
	});

	test('a nextUid equal to the uid is refused before anything is sent', async () => {
		const index = bindIndex(t.client, movies);
		const error = await index
			.rebuild(async () => {}, { nextUid: 'movies' })
			.catch((e) => e);
		expect(error).toBeInstanceOf(TypeError);
		expect(error.message).toBe(
			'rebuild on "movies": nextUid must differ from the index\'s own uid',
		);
		expect(await uids()).toEqual([]);
	});
});
