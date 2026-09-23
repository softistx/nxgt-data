import { describe, expect, test } from 'bun:test';
import { eventually, toHit, useServers } from '../test/fixtures';
import { SearchSyncError } from './errors';

const { servers, collection, sync, start, track, indexed } =
	useServers('lease');

// A second `createSearchSync` under the same name is what another process
// is: its own context, so the in-process `RUNNING` check does not see the
// first one, and only the lease in MongoDB stands between them.

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

const leases = () =>
	servers.mongo.db.collection<{
		_id: { lease: string };
		holder: string;
		expiresAt: Date;
	}>('nxgt_search_sync');

const leaseOf = (name = 'articles:articles') =>
	leases().findOne({ _id: { lease: name } });

describe('the lease on a sync name', () => {
	test('a second process cannot start a name the first one follows', async () => {
		await start();
		const error = await rejection(sync().start());
		expect(error.code).toBe('RUNNING');
		expect(error.message).toMatch(
			/^Search sync "articles:articles" is held by .+:\d+:[0-9a-f]{24} until \d{4}-.+Z: wait for it to close, or for its lease to lapse, before you start it\.$/,
		);
	});

	test('nor reindex it, which would remove what the follower just sent', async () => {
		await start();
		const error = await rejection(sync().reindex());
		expect(error.code).toBe('RUNNING');
		expect(error.message).toEndWith('before you reindex.');
	});

	test('the name is free as soon as the first one closes', async () => {
		const first = await sync().start();
		await first.close();
		expect(await leaseOf()).toBeNull();
		track(await sync().start());
	});

	test('a reindex holds the name while it runs, and lets go after', async () => {
		await collection().create({ title: 'One' });
		const reindexing = sync().reindex();
		// The reindex took the lease before reading anything.
		await eventually(async () => (await leaseOf()) !== null, true);
		expect((await rejection(sync().start())).code).toBe('RUNNING');
		await reindexing;
		expect(await leaseOf()).toBeNull();
	});

	test('a start that fails lets go of the name', async () => {
		await collection().create({ title: 'One' });
		const error = await rejection(
			sync({
				transform: () => {
					throw new Error('no');
				},
			}).start(),
		);
		expect(error.code).toBe('FAILED');
		expect(await leaseOf()).toBeNull();
	});

	test('a holder that died is taken over once its lease lapses, and not before', async () => {
		// What a process that crashed leaves behind: a lease nobody renews.
		await leases().insertOne({
			_id: { lease: 'articles:articles' },
			holder: 'gone:1:000000000000000000000000',
			expiresAt: new Date(Date.now() + 400),
		});
		const early = await rejection(sync().start());
		expect(early.message).toContain('held by gone:1:');
		await Bun.sleep(500);
		track(await sync().start());
		expect((await leaseOf())?.holder).not.toStartWith('gone:');
	});

	test('a running sync renews its lease, so it outlives leaseMs', async () => {
		await start({ leaseMs: 300 });
		const before = (await leaseOf())?.expiresAt.getTime() ?? 0;
		await Bun.sleep(700);
		const after = (await leaseOf())?.expiresAt.getTime() ?? 0;
		expect(after).toBeGreaterThan(before);
		expect((await rejection(sync({ leaseMs: 300 }).start())).code).toBe(
			'RUNNING',
		);
	});

	test('a first reindex longer than leaseMs keeps the name', async () => {
		await collection().create({ title: 'One' });
		await collection().create({ title: 'Two' });
		const slow = sync({
			leaseMs: 300,
			transform: async (document) => {
				await Bun.sleep(400);
				return toHit(document);
			},
		}).start();
		// Past the lease's first end, while the first start still reindexes.
		await Bun.sleep(500);
		expect((await rejection(sync({ leaseMs: 300 }).start())).code).toBe(
			'RUNNING',
		);
		track(await slow);
	});

	test('a sync whose lease was taken stops with LEASE_LOST, and sends nothing more', async () => {
		const running = await start({ leaseMs: 300 });
		// Another process took the name: the lease is no longer this one's.
		await leases().updateOne(
			{ _id: { lease: 'articles:articles' } },
			{ $set: { holder: 'thief:1:000000000000000000000000' } },
		);
		const error = await rejection(running.closed);
		expect(error.code).toBe('LEASE_LOST');
		expect(error.message).toBe(
			'Search sync "articles:articles" lost its lease: it was not renewed ' +
				'within 300 ms, and another process may have taken the name over. ' +
				'It stopped rather than follow beside it.',
		);
		await collection().create({ title: 'After' });
		await Bun.sleep(300);
		expect(await indexed()).toEqual([]);
		// The thief's lease is left alone.
		expect((await leaseOf())?.holder).toStartWith('thief:');
	});

	test('two names do not share a lease', async () => {
		await start();
		track(await sync({ name: 'articles:other' }).start());
		expect(await leaseOf('articles:other')).not.toBeNull();
	});
});
