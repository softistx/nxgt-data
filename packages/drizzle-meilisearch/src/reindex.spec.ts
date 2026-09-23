import { describe, expect, test } from 'bun:test';
import { type Article, useServers } from '../test/fixtures';
import { SearchSyncError } from './errors';
import type { ReindexProgress } from './types';

const { repository, index, sync, indexed } = useServers();

const seed = (rows: { title: string; draft?: boolean }[]) =>
	repository().createMany(rows);

describe('reindexAll', () => {
	test('sends every live row, and says how many', async () => {
		await seed([{ title: 'a' }, { title: 'b' }]);
		const report = await sync().reindexAll();
		expect(report).toEqual({ indexed: 2, skipped: 0, removed: 0 });
		expect((await indexed()).map(([, title]) => title).sort()).toEqual([
			'a',
			'b',
		]);
	});

	test('the documents are there when it returns, not a moment later', async () => {
		await seed([{ title: 'a' }]);
		await sync().reindexAll();
		// No `eventually`: `reindexAll` waits for every batch, because what it
		// removes is decided by reading the index back.
		expect(await indexed()).toHaveLength(1);
	});

	test('counts the rows the transform keeps out, and leaves them out', async () => {
		await seed([{ title: 'a' }, { title: 'draft', draft: true }]);
		const report = await sync().reindexAll();
		expect(report).toEqual({ indexed: 1, skipped: 1, removed: 0 });
		expect((await indexed()).map(([, title]) => title)).toEqual(['a']);
	});

	test('takes out what the index holds and the table does not', async () => {
		const live = await repository().create({ title: 'a' });
		await index().add(
			[
				{ id: live.id, title: 'a' },
				{ id: '00000000-0000-4000-8000-000000000000', title: 'gone' },
			],
			{ wait: true },
		);
		const report = await sync().reindexAll();
		expect(report).toEqual({ indexed: 1, skipped: 0, removed: 1 });
		expect((await indexed()).map(([, title]) => title)).toEqual(['a']);
	});

	test('takes out a row that was soft deleted', async () => {
		const gone = await repository().create({ title: 'gone' });
		const live = await repository().create({ title: 'live' });
		await sync().reindexAll();
		await repository().delete(gone.id);
		const report = await sync().reindexAll();
		expect(report).toEqual({ indexed: 1, skipped: 0, removed: 1 });
		expect(await indexed()).toEqual([[live.id, 'live']]);
	});

	test('pages through the table', async () => {
		await seed(Array.from({ length: 5 }, (_, i) => ({ title: `title ${i}` })));
		const report = await sync({ pageSize: 2 }).reindexAll();
		expect(report.indexed).toBe(5);
		expect(await indexed()).toHaveLength(5);
	});

	test('reports each page with the running counts, after it is applied', async () => {
		await seed([
			{ title: 'a' },
			{ title: 'b', draft: true },
			{ title: 'c' },
			{ title: 'd' },
			{ title: 'e' },
		]);
		const seen: { progress: object; there: number }[] = [];
		const report = await sync().reindexAll({
			pageSize: 2,
			onPage: async (progress) => {
				// Applied, not only sent: the index already holds the page.
				seen.push({ progress, there: (await indexed()).length });
			},
		});
		// The cursor pages by id, so where the draft falls is not fixed: what
		// is, is that every page is counted once it is in the index.
		expect(seen.map(({ progress }) => progress)).toMatchObject([
			{ pages: 1 },
			{ pages: 2 },
			{ pages: 3 },
		]);
		for (const [i, { progress, there }] of seen.entries()) {
			const { indexed, skipped } = progress as ReindexProgress;
			expect(there).toBe(indexed);
			expect(indexed + skipped).toBe(Math.min(5, 2 * (i + 1)));
		}
		expect(seen.at(-1)?.progress).toEqual({ pages: 3, indexed: 4, skipped: 1 });
		expect(report).toEqual({ indexed: 4, skipped: 1, removed: 0 });
	});

	test('an onPage that throws stops the reindex, as the cause of FAILED', async () => {
		await seed(Array.from({ length: 4 }, (_, i) => ({ title: `t${i}` })));
		const stop = new Error('stop');
		let calls = 0;
		const error = (await sync()
			.reindexAll({
				pageSize: 2,
				onPage: () => {
					calls += 1;
					throw stop;
				},
			})
			.catch((e: unknown) => e)) as SearchSyncError;
		expect(error).toBeInstanceOf(SearchSyncError);
		expect(error.code).toBe('FAILED');
		expect(error.cause).toBe(stop);
		expect(calls).toBe(1);
		expect(await indexed()).toHaveLength(2);
	});

	test('a pageSize given to the call wins over the one given to the sync', async () => {
		await seed([{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
		const report = await sync({ pageSize: 100 }).reindexAll({ pageSize: 1 });
		expect(report.indexed).toBe(3);
	});

	test('sends in batches of batchSize', async () => {
		await seed(Array.from({ length: 5 }, (_, i) => ({ title: `t${i}` })));
		const report = await sync({ batchSize: 2 }).reindexAll();
		expect(report.indexed).toBe(5);
		expect(await indexed()).toHaveLength(5);
	});

	test('an empty table, on an index nothing was ever written to', async () => {
		const report = await sync().reindexAll();
		expect(report).toEqual({ indexed: 0, skipped: 0, removed: 0 });
	});

	test('refuses a transform that gives something else', async () => {
		await seed([{ title: 'a' }]);
		const error = (await sync({
			transform: (() => 'a string') as never,
		})
			.reindexAll()
			.catch((e: unknown) => e)) as SearchSyncError;
		// `NOT_A_DOCUMENT`, not `FAILED`: a bare `TypeError` would have come
		// back as the code that means "anything else".
		expect(error).toBeInstanceOf(SearchSyncError);
		expect(error.code).toBe('NOT_A_DOCUMENT');
		expect(error.message).toContain('transform gave a string');
		expect(error.sync).toBe('articles:articles');
	});

	test('refuses a document under another id', async () => {
		await seed([{ title: 'a' }]);
		const error = (await sync({
			transform: ((row: Article) => ({
				id: 'other',
				title: row.title,
			})) as never,
		})
			.reindexAll()
			.catch((e: unknown) => e)) as SearchSyncError;
		expect(error.code).toBe('ID_MISMATCH');
		expect(error.message).toContain('could never be taken out');
	});

	test('wraps anything else as FAILED, with the cause', async () => {
		await seed([{ title: 'a' }]);
		const boom = new Error('nope');
		const error = (await sync({
			transform: (() => {
				throw boom;
			}) as never,
		})
			.reindexAll()
			.catch((e: unknown) => e)) as SearchSyncError;
		expect(error.code).toBe('FAILED');
		expect(error.cause).toBe(boom);
		expect(error.message).toContain('failed reindexing: nope');
	});
});
