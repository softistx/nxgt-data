import { describe, expect, test } from 'bun:test';
import { byId, eventually, useServers } from '../test/fixtures';
import { SearchSyncError } from './errors';

const { servers, collection, index, sync, start, track, indexed } =
	useServers('follow');

/** The lease on the default sync's name, or `null` once it was let go. */
const leaseOf = () =>
	servers.mongo.db
		.collection('nxgt_search_sync')
		.findOne({ _id: { lease: 'articles:articles' } } as object);

const rejection = (promise: Promise<unknown>) =>
	promise.then(
		() => {
			throw new Error('it resolved');
		},
		(error: unknown) => {
			if (!(error instanceof SearchSyncError)) throw error;
			return error;
		},
	);

describe('start', () => {
	test('reindexes the first time, then follows every change', async () => {
		const first = await collection().create({ title: 'First' });
		const running = await start();
		expect(await indexed()).toEqual([[String(first._id), 'First']]);

		const second = await collection().create({ title: 'Second' });
		await collection().update(first._id, { title: 'First, renamed' });
		await eventually(
			indexed,
			byId([
				[String(first._id), 'First, renamed'],
				[String(second._id), 'Second'],
			]),
		);

		await collection().delete(second._id);
		await eventually(indexed, [[String(first._id), 'First, renamed']]);
		await collection().restore(second._id);
		await eventually(
			indexed,
			byId([
				[String(first._id), 'First, renamed'],
				[String(second._id), 'Second'],
			]),
		);
		await collection().hardDelete(first._id);
		await eventually(indexed, [[String(second._id), 'Second']]);

		await running.close();
		expect(await running.closed).toBe('closed');
	});

	test('a document the transform turns away is taken out', async () => {
		const article = await collection().create({ title: 'Soon a draft' });
		await start();
		await collection().update(article._id, { draft: true });
		await eventually(indexed, []);
		await collection().update(article._id, { draft: false });
		await eventually(indexed, [[String(article._id), 'Soon a draft']]);
	});

	test('picks up where the last run stopped', async () => {
		const search = sync();
		const running = track(await search.start());
		const kept = await collection().create({ title: 'Kept' });
		await eventually(indexed, [[String(kept._id), 'Kept']]);
		await running.close();
		const after = await search.state();
		expect(after?.updatedAt.getTime()).toBeGreaterThan(
			after?.reindexedAt?.getTime() ?? Number.POSITIVE_INFINITY,
		);

		const missed = await collection().create({ title: 'Made while stopped' });
		await collection().delete(kept._id);
		await index().add([{ id: 'stale', title: 'no reindex removes me' }], {
			wait: true,
		});

		await start();
		await eventually(indexed, [
			[String(missed._id), 'Made while stopped'],
			['stale', 'no reindex removes me'],
		]);
		expect((await search.state())?.reindexedAt).toEqual(
			after?.reindexedAt as Date,
		);
	});
});

describe('batches', () => {
	test('changes wait for flushIntervalMs, then go together', async () => {
		const running = await start({ flushIntervalMs: 60_000 });
		const a = await collection().create({ title: 'a' });
		const b = await collection().create({ title: 'b' });
		await Bun.sleep(300);
		expect(await indexed()).toEqual([]);

		await running.flush();
		expect((await indexed()).map(([id]) => id).sort()).toEqual(
			[String(a._id), String(b._id)].sort(),
		);
	});

	test('a full batch is sent without waiting', async () => {
		await start({ flushIntervalMs: 60_000, batchSize: 3 });
		await collection().createMany([
			{ title: 'a' },
			{ title: 'b' },
			{ title: 'c' },
		]);
		await eventually(async () => (await indexed()).length, 3);
	});

	test('the last change of a document wins', async () => {
		const running = await start({ flushIntervalMs: 60_000 });
		const article = await collection().create({ title: 'one' });
		await collection().update(article._id, { title: 'two' });
		await collection().update(article._id, { title: 'three' });
		await Bun.sleep(300);
		await running.flush();
		expect(await indexed()).toEqual([[String(article._id), 'three']]);
	});

	test('close sends what is waiting, and records it', async () => {
		const search = sync({ flushIntervalMs: 60_000 });
		const running = track(await search.start());
		const before = await search.state();
		const article = await collection().create({ title: 'late' });
		await Bun.sleep(300);
		await running[Symbol.asyncDispose]();
		expect(await indexed()).toEqual([[String(article._id), 'late']]);
		expect(await running.closed).toBe('closed');
		expect((await search.state())?.resumeToken).not.toEqual(
			before?.resumeToken,
		);
	});

	test('a flush with nothing to send records only where the stream is', async () => {
		const search = sync({ flushIntervalMs: 60_000 });
		const running = track(await search.start());
		const started = await search.state();
		await running.flush();
		const idle = await search.state();
		expect(idle?.reindexedAt).toEqual(started?.reindexedAt as Date);
		expect(await indexed()).toEqual([]);

		await collection().create({ title: 'a' });
		await Bun.sleep(300);
		await running.flush();
		const flushed = await search.state();
		expect(flushed?.updatedAt).not.toEqual(idle?.updatedAt as Date);
		expect(await indexed()).toHaveLength(1);

		// Sent once: a second flush has nothing left to send.
		await running.flush();
		expect(await indexed()).toHaveLength(1);
	});
});

describe('a quiet collection', () => {
	test('records where the stream is, so its point stays fresh', async () => {
		const search = sync({ positionIntervalMs: 60 });
		const running = track(await search.start());
		const first = await search.state();
		expect(first?.resumeToken).toBeDefined();

		// Nothing is written to the collection from here on.
		await eventually(
			async () => (await search.state())?.resumeToken !== first?.resumeToken,
			true,
		);
		const moved = await search.state();
		expect(moved?.reindexedAt).toEqual(first?.reindexedAt as Date);

		// It is a point to resume from: a change made after it still arrives.
		await running.close();
		const late = await collection().create({ title: 'late' });
		await start();
		await eventually(indexed, [[String(late._id), 'late']]);
	});

	test('a change waiting to be sent is never skipped by the beat', async () => {
		const search = sync({ flushIntervalMs: 60_000, positionIntervalMs: 60 });
		const running = track(await search.start());
		const article = await collection().create({ title: 'waiting' });
		await Bun.sleep(300);

		// The beat has run several times over a change that is still pending.
		await running.close();
		expect(await indexed()).toEqual([[String(article._id), 'waiting']]);
		await start();
		await eventually(indexed, [[String(article._id), 'waiting']]);
	});
});

describe('when the history is gone', () => {
	test('it reindexes, by default', async () => {
		const search = sync();
		await search.reindex();
		const reindexedAt = (await search.state())?.reindexedAt;
		const article = await collection().create({ title: 'a' });
		await servers.mongo.failNext(['aggregate'], { errorCode: 286 });

		await start();

		expect(await indexed()).toEqual([[String(article._id), 'a']]);
		expect((await search.state())?.reindexedAt?.getTime()).toBeGreaterThan(
			reindexedAt?.getTime() ?? 0,
		);
	});

	test("it throws HISTORY_LOST with onHistoryLost: 'fail'", async () => {
		const search = sync({ onHistoryLost: 'fail' });
		await search.reindex();
		await servers.mongo.failNext(['aggregate'], { errorCode: 280 });

		const error = await rejection(search.start());

		expect(error.code).toBe('HISTORY_LOST');
		expect(error.sync).toBe('articles:articles');
		expect(error.message).toContain('Reindex it');
		expect((error.cause as { serverCode?: number }).serverCode).toBe(280);
		expect(await leaseOf()).toBeNull();
	});

	test('a failure of the reindexed start is reported as such', async () => {
		const search = sync();
		await search.reindex();
		await servers.mongo.failNext(['aggregate'], { errorCode: 286 }, 3);
		const error = await rejection(search.start());
		expect(error.code).toBe('FAILED');
		expect(await leaseOf()).toBeNull();
	});
});

describe('what stops a running sync', () => {
	test('a server error at start', async () => {
		await sync().reindex();
		await servers.mongo.failNext(['aggregate'], { errorCode: 13 });
		const error = await rejection(sync().start());
		expect(error.code).toBe('FAILED');
		expect(error.message).toStartWith(
			'Search sync "articles:articles" failed starting:',
		);
	});

	test('a transform that throws: nothing past it is recorded', async () => {
		const search = sync();
		const kept = await collection().create({ title: 'kept' });
		await search.reindex();
		const before = await search.state();
		const boom = new Error('boom');
		const running = track(
			await sync({
				transform: (article) => {
					if (article.title === 'bad') throw boom;
					return { id: String(article._id), title: article.title };
				},
			}).start(),
		);

		await collection().create({ title: 'bad' });
		const error = await rejection(running.closed);

		expect(error.code).toBe('FAILED');
		expect(error.message).toBe(
			'Search sync "articles:articles" failed following changes: boom',
		);
		expect(await search.state()).toEqual(before);
		expect(await indexed()).toEqual([[String(kept._id), 'kept']]);
		expect(await rejection(running.flush())).toBe(error);
		expect(await rejection(running.close())).toBe(error);
	});

	test('a document under another id', async () => {
		const running = await start({
			transform: (article) => ({ id: 'other', title: article.title }),
		});
		await collection().create({ title: 'a' });
		const error = await rejection(running.closed);
		expect(error.code).toBe('ID_MISMATCH');
	});

	test('a batch Meilisearch refuses, sent by the timer', async () => {
		const running = await start({
			toIndexId: (id) => `not an id ${String(id)}`,
			transform: (article) => ({
				id: `not an id ${String(article._id)}`,
				title: article.title,
			}),
		});
		await collection().create({ title: 'a' });
		const error = await rejection(running.closed);
		expect(error.code).toBe('FAILED');
		expect(error.message).toStartWith(
			'Search sync "articles:articles" failed sending changes:',
		);
		expect(await rejection(running.flush())).toBe(error);
	});

	test('a batch Meilisearch refuses, sent by flush', async () => {
		const running = await start({
			flushIntervalMs: 60_000,
			toIndexId: (id) => `not an id ${String(id)}`,
			transform: (article) => ({
				id: `not an id ${String(article._id)}`,
				title: article.title,
			}),
		});
		await collection().create({ title: 'a' });
		await Bun.sleep(300);
		const error = await rejection(running.flush());
		expect(error.code).toBe('FAILED');
		await collection().create({ title: 'b' });
		expect(await rejection(running.closed)).toBe(error);
	});

	test('the collection dropped, and what a later start does', async () => {
		const search = sync();
		const running = track(await search.start());
		const gone = await collection().create({ title: 'gone' });
		await eventually(indexed, [[String(gone._id), 'gone']]);

		await collection().raw.drop();

		expect(await running.closed).toBe('invalidated');
		// Nothing is recorded any more: the point it stopped at is in a
		// collection that no longer exists, and every later start would stop
		// there again.
		expect(await search.state()).toBeUndefined();

		await collection().sync();
		const fresh = await collection().create({ title: 'fresh' });
		await start();
		await eventually(indexed, [[String(fresh._id), 'fresh']]);
	});

	test('a sync that is already following refuses to run twice', async () => {
		const search = sync();
		track(await search.start());
		const started = await rejection(search.start());
		expect(started.code).toBe('RUNNING');
		expect(started.message).toBe(
			'Search sync "articles:articles" is already following changes in ' +
				'this process: close it before you start it twice.',
		);
		// Nothing to wait for: only a close frees a name this process follows.
		expect(started.holder).toBeUndefined();
		expect(started.expiresAt).toBeUndefined();
		const reindexed = await rejection(search.reindex());
		expect(reindexed.code).toBe('RUNNING');
		expect(reindexed.message).toEndWith('before you reindex.');
	});

	test('once closed, it may reindex and start again', async () => {
		const search = sync();
		const running = track(await search.start());
		await running.close();
		await search.reindex();
		track(await search.start());
	});
});
