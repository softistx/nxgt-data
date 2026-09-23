import { describe, expect, test } from 'bun:test';
import { eventually, toHit, useServers } from '../test/fixtures';
import { SearchSyncError } from './errors';

const { servers, collection, index, sync, start, track, indexed } =
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

	test("its RUNNING carries the lease document's holder and expiresAt", async () => {
		await start();
		const error = await rejection(sync().start());
		const lease = await leaseOf();
		expect(lease).not.toBeNull();
		expect(error.holder).toBe(lease?.holder as string);
		expect(error.expiresAt).toEqual(lease?.expiresAt as Date);
		// The same two the message prints.
		expect(error.message).toContain(
			`held by ${error.holder} until ${error.expiresAt?.toISOString()}:`,
		);
	});

	test('a standby that waits until expiresAt takes over a dead holder, with no fixed sleep', async () => {
		// A holder that died: its lease is not renewed, and lapses at `lapse`.
		// Far enough ahead that a stalled runner cannot reach it before the
		// first start, which the loop also asserts is refused.
		const lapse = new Date(Date.now() + 1500);
		await leases().insertOne({
			_id: { lease: 'articles:articles' },
			holder: 'gone:1:000000000000000000000000',
			expiresAt: lapse,
		});
		const standby = sync({ leaseMs: 300 });
		let attempts = 0;
		for (;;) {
			attempts += 1;
			const outcome = await standby.start().then(
				(running) => track(running),
				(error: unknown) => {
					if (!(error instanceof SearchSyncError)) throw error;
					return error;
				},
			);
			if (!(outcome instanceof SearchSyncError)) {
				if (attempts === 1) throw new Error('the first start was not refused');
				break;
			}
			expect(outcome.code).toBe('RUNNING');
			expect(outcome.holder).toBe('gone:1:000000000000000000000000');
			expect(outcome.expiresAt).toEqual(lapse);
			// Exactly until the lease lapses, and not a moment longer.
			await Bun.sleep(outcome.expiresAt as Date);
			if (attempts > 1) throw new Error('refused again after expiresAt');
		}
		expect(attempts).toBe(2);
		expect((await leaseOf())?.holder).not.toStartWith('gone:');
	});

	test('nor reindex it, which would remove what the follower just sent', async () => {
		await start();
		const error = await rejection(sync().reindex());
		expect(error.code).toBe('RUNNING');
		expect(error.message).toEndWith('before you reindex.');
		const lease = await leaseOf();
		expect(lease).not.toBeNull();
		expect(error.holder).toBe(lease?.holder as string);
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
			'Search sync "articles:articles" lost its lease: another process ' +
				'holds the name now, or the lease was removed (it lapses when not ' +
				'renewed within 300 ms). It stopped rather than run beside it.',
		);
		await collection().create({ title: 'After' });
		await Bun.sleep(300);
		expect(await indexed()).toEqual([]);
		// The thief's lease is left alone.
		expect((await leaseOf())?.holder).toStartWith('thief:');
	});

	/** A transform slow enough for the lease to be taken while it runs. */
	const slowly = async (document: Parameters<typeof toHit>[0]) => {
		await Bun.sleep(150);
		return toHit(document);
	};
	const steal = () =>
		leases().updateOne(
			{ _id: { lease: 'articles:articles' } },
			{ $set: { holder: 'thief:1:000000000000000000000000' } },
		);

	test('a reindex whose lease is taken stops before it removes or records anything', async () => {
		for (const title of ['a', 'b', 'c', 'd']) {
			await collection().create({ title });
		}
		// What the new holder indexed meanwhile, which this reindex never read.
		await index()
			.raw.addDocuments([{ id: 'theirs', title: 'kept' }])
			.waitTask();
		const search = sync({ leaseMs: 90, pageSize: 1, transform: slowly });
		const reindexing = rejection(search.reindex());
		await eventually(async () => (await leaseOf()) !== null, true);
		await steal();
		const error = await reindexing;
		expect(error.code).toBe('LEASE_LOST');
		expect(await search.state()).toBeUndefined();
		expect((await indexed()).map(([id]) => id)).toContain('theirs');
		expect((await leaseOf())?.holder).toStartWith('thief:');
	});

	test('so does the first reindex of a start, which then follows nothing', async () => {
		await collection().create({ title: 'a' });
		await collection().create({ title: 'b' });
		const search = sync({ leaseMs: 90, pageSize: 1, transform: slowly });
		const starting = rejection(search.start());
		await eventually(async () => (await leaseOf()) !== null, true);
		await steal();
		expect((await starting).code).toBe('LEASE_LOST');
		expect(await search.state()).toBeUndefined();
		expect((await leaseOf())?.holder).toStartWith('thief:');
	});

	test('a lease that cannot be taken is FAILED, not RUNNING', async () => {
		await servers.mongo.failNext(['findAndModify'], { errorCode: 13 });
		const error = await rejection(sync().start());
		expect(error.code).toBe('FAILED');
		expect(error.message).toStartWith(
			'Search sync "articles:articles" failed taking its lease:',
		);
	});

	test('a lease check that cannot reach MongoDB stops the reindex before it removes', async () => {
		await collection().create({ title: 'a' });
		await index()
			.raw.addDocuments([{ id: 'theirs', title: 'kept' }])
			.waitTask();
		// The take, then the check before removing: the check fails.
		await servers.mongo.failNext(['update'], { errorCode: 13 });
		const error = await rejection(sync({ leaseMs: 60_000 }).reindex());
		expect(error.code).toBe('FAILED');
		expect(error.message).toStartWith(
			'Search sync "articles:articles" failed checking its lease:',
		);
		expect((await indexed()).map(([id]) => id)).toContain('theirs');
	});

	test('two names do not share a lease', async () => {
		await start();
		track(await sync({ name: 'articles:other' }).start());
		expect(await leaseOf('articles:other')).not.toBeNull();
	});
});
