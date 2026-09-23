import { describe, expect, test } from 'bun:test';
import { type Article, eventually, useServers } from '../test/fixtures';
import type { SearchSyncError } from './errors';

const { repository, sync, indexed } = useServers();

const titles = async () => (await indexed()).map(([, title]) => title).sort();

describe('indexing a row after a write', () => {
	test('sends the row a create gave back', async () => {
		const article = await repository().create({ title: 'a' });
		await sync().indexRow(article, { wait: true });
		expect(await indexed()).toEqual([[article.id, 'a']]);
	});

	test('returns before Meilisearch has applied it, without wait', async () => {
		const article = await repository().create({ title: 'a' });
		await sync().indexRow(article);
		// The default: a request that has just written a row does not hold its
		// response open for the index. The document arrives a moment later.
		await eventually(titles, ['a']);
	});

	test('sends the rows a createMany gave back', async () => {
		const rows = await repository().createMany([
			{ title: 'a' },
			{ title: 'b' },
		]);
		await sync().indexRows(rows, { wait: true });
		expect(await titles()).toEqual(['a', 'b']);
	});

	test('sends them in batches of batchSize', async () => {
		const rows = await repository().createMany(
			Array.from({ length: 5 }, (_, i) => ({ title: `t${i}` })),
		);
		await sync({ batchSize: 2 }).indexRows(rows, { wait: true });
		expect(await indexed()).toHaveLength(5);
	});

	test('takes out a row the transform now keeps out', async () => {
		const search = sync();
		const article = await repository().create({ title: 'a' });
		await search.indexRow(article, { wait: true });
		const draft = await repository().update(article.id, { draft: true });
		await search.indexRow(draft, { wait: true });
		expect(await indexed()).toEqual([]);
	});

	test('sends an updated row under the same id', async () => {
		const search = sync();
		const article = await repository().create({ title: 'a' });
		await search.indexRow(article, { wait: true });
		const renamed = await repository().update(article.id, { title: 'b' });
		await search.indexRow(renamed, { wait: true });
		expect(await indexed()).toEqual([[article.id, 'b']]);
	});

	test('sends nothing for an empty list', async () => {
		await sync().indexRows([], { wait: true });
		expect(await indexed()).toEqual([]);
	});

	test('refuses a document under another id', async () => {
		const article = await repository().create({ title: 'a' });
		const error = (await sync({
			transform: ((row: Article) => ({
				id: 'other',
				title: row.title,
			})) as never,
		})
			.indexRow(article)
			.catch((e: unknown) => e)) as SearchSyncError;
		expect(error.code).toBe('ID_MISMATCH');
	});

	test('wraps anything else as FAILED, with the cause', async () => {
		const article = await repository().create({ title: 'a' });
		const boom = new Error('nope');
		const error = (await sync({
			transform: (() => {
				throw boom;
			}) as never,
		})
			.indexRow(article)
			.catch((e: unknown) => e)) as SearchSyncError;
		expect(error.code).toBe('FAILED');
		expect(error.message).toContain('failed indexing rows: nope');
		expect(error.cause).toBe(boom);
	});
});

describe('taking a row out', () => {
	test('removes the row a delete gave back', async () => {
		const search = sync();
		const article = await repository().create({ title: 'a' });
		await search.indexRow(article, { wait: true });
		const deleted = await repository().delete(article.id);
		await search.removeRow(deleted, { wait: true });
		expect(await indexed()).toEqual([]);
	});

	test('removes by index id, when the row itself is gone', async () => {
		const search = sync();
		const article = await repository().create({ title: 'a' });
		await search.indexRow(article, { wait: true });
		await repository().hardDelete(article.id);
		await search.remove(article.id, { wait: true });
		expect(await indexed()).toEqual([]);
	});

	test('removes several ids in one call', async () => {
		const search = sync();
		const rows = await repository().createMany([
			{ title: 'a' },
			{ title: 'b' },
			{ title: 'c' },
		]);
		await search.indexRows(rows, { wait: true });
		await search.removeMany(
			rows.slice(0, 2).map((row) => row.id),
			{ wait: true },
		);
		expect(await titles()).toEqual(['c']);
	});

	test('sends nothing for no ids', async () => {
		await sync().removeMany([], { wait: true });
		expect(await indexed()).toEqual([]);
	});

	test('removing an id the index does not hold is not an error', async () => {
		const search = sync();
		const article = await repository().create({ title: 'a' });
		await search.indexRow(article, { wait: true });
		await search.remove('00000000-0000-4000-8000-000000000000', {
			wait: true,
		});
		expect(await titles()).toEqual(['a']);
	});

	test('a wait on an index nothing has created says so', async () => {
		// Measured: Meilisearch creates an index on a write of documents, but
		// not on a delete. Without `wait` the task is enqueued and fails where
		// nobody is looking, which is why `reindexAll` waits.
		const error = (await sync()
			.remove('00000000-0000-4000-8000-000000000000', { wait: true })
			.catch((e: unknown) => e)) as SearchSyncError;
		expect(error.code).toBe('FAILED');
		expect(error.message).toMatch(
			/^Search sync "[^"]+" failed removing documents: Task \d+ \(delete\) on index "articles" failed: index_not_found$/,
		);
		// Meilisearch's sentence is on the index error, not in the message.
		const cause = error.cause as Error & { cause: Error };
		expect(cause.cause.message).toContain('Index `articles` not found');
	});
});

describe('a toIndexId that throws', () => {
	test('rejects, it does not throw where a catch cannot see it', async () => {
		const article = await repository().create({ title: 'a' });
		const boom = new Error('no id');
		const search = sync({
			toIndexId: (() => {
				throw boom;
			}) as never,
		});
		// `removeRow` reads the id before it calls the index, so without an
		// `async` there the throw would arrive synchronously.
		const error = (await search
			.removeRow(article)
			.catch((e: unknown) => e)) as SearchSyncError;
		expect(error.code).toBe('FAILED');
		expect(error.message).toContain('failed reading an index id: no id');
		expect(error.cause).toBe(boom);
	});
});

describe('two states of one row in the same call', () => {
	test('the last one wins, and the add is not undone by the delete', async () => {
		const search = sync();
		const article = await repository().create({ title: 'a' });
		// A caller batching its writes can hand over the same row twice: the
		// draft transforms to `null`, so without a dedup the delete at the end
		// of `send` would take out the document the add had just written.
		await search.indexRows([{ ...article, draft: true }, article], {
			wait: true,
		});
		expect(await indexed()).toEqual([[article.id, 'a']]);
	});

	test('and the other way round, the row is taken out', async () => {
		const search = sync();
		const article = await repository().create({ title: 'a' });
		// Indexed first, so the index exists: a call whose only entry is a
		// delete cannot create one, as this page's other test measures.
		await search.indexRow(article, { wait: true });
		await search.indexRows([article, { ...article, draft: true }], {
			wait: true,
		});
		expect(await indexed()).toEqual([]);
	});
});
