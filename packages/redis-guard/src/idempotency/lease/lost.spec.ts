import { describe, expect, test } from 'bun:test';
import {
	createOrder,
	gate,
	useClients,
	useRedis,
} from '../../../test/fixtures';
import { rejection } from '../../../test/rejection';
import { bindIdempotency } from '../bind-idempotency';
import { defineIdempotency } from '../define-idempotency';

// A key taken from a run before it finished: forgotten, or deleted and taken
// by another run — here by a second client, as another process would. The
// heartbeat keeps a live run's lease from lapsing, so the specs take the key
// rather than wait for a lapse. The late run reports LEASE_LOST, stores
// nothing, and leaves the other holder's record exactly as it was.

const servers = useRedis();
const clients = useClients(servers);
const who = { user: 'u1', key: 'k1' };

/** 60 ms, renewed every 20 ms: a short lease, as the late run's. */
const short = defineIdempotency({ ...createOrder, name: 'lost', lease: 60 });
/** The same operation as another process holding it far longer. */
const long = defineIdempotency({ ...short, lease: 60_000 });
const KEY = 'lost:u1/k1';
const FOREIGN = 'f'.repeat(32);

/** Long enough for several of the short lease's renewals. */
const beats = () => Bun.sleep(150);

describe('a key taken from a run', () => {
	test('forgotten mid-run: LEASE_LOST, and nothing is stored', async () => {
		const [a] = clients();
		const bound = bindIdempotency(a, short);
		const error = await rejection(
			bound.run(who, async () => {
				await bound.forget(who);
				await beats();
				return { orderId: 'o1', total: 1 };
			}),
		);
		expect(error).toMatchObject({ code: 'LEASE_LOST', definition: 'lost' });
		expect(await servers.redis.client.exists(KEY)).toBe(false);
	});

	test('taken by another token mid-run: LEASE_LOST, and that record is untouched', async () => {
		const [a, b] = clients();
		const error = await rejection(
			bindIdempotency(a, short).run(who, async () => {
				await b.del(KEY);
				await b.hset(KEY, { state: 'running', token: FOREIGN, fp: '' });
				await b.pexpire(KEY, 60_000);
				await beats();
				return { orderId: 'o1', total: 1 };
			}),
		);
		expect(error).toMatchObject({ code: 'LEASE_LOST' });
		const client = servers.redis.client;
		expect(await client.hgetall(KEY)).toEqual({
			state: 'running',
			token: FOREIGN,
			fp: '',
		});
		// Not renewed to the late run's 60 ms: its renewals compared tokens.
		expect(await client.pttl(KEY)).toBeGreaterThan(55_000);
	});

	test('a repeat after it was taken runs again, and the late run cannot store over it', async () => {
		const [a, b] = clients();
		const aTook = gate();
		const aMayFinish = gate();
		const late = rejection(
			bindIdempotency(a, short).run(who, async () => {
				aTook.open();
				await aMayFinish.opened;
				return { orderId: 'late', total: 1 };
			}),
		);
		await aTook.opened;
		await b.del(KEY);
		// B takes the key and holds it while A beats, then tries to store.
		const bMayFinish = gate();
		const second = bindIdempotency(b, long).run(who, async () => {
			await beats();
			aMayFinish.open();
			await bMayFinish.opened;
			return { orderId: 'second', total: 2 };
		});
		expect(await late).toMatchObject({ code: 'LEASE_LOST' });
		expect(await servers.redis.client.pttl(KEY)).toBeGreaterThan(55_000);
		bMayFinish.open();
		expect((await second).value.orderId).toBe('second');
		// B's result, not A's, is what replays.
		const replay = await bindIdempotency(a, short).run(who, () => ({
			orderId: 'third',
			total: 3,
		}));
		expect(replay).toEqual({
			value: { orderId: 'second', total: 2, status: 'placed' },
			replayed: true,
		});
	});

	test('a late failure cannot release the key another run has taken since', async () => {
		const [a, b] = clients();
		const aTook = gate();
		const aMayFail = gate();
		const boom = new Error('late failure');
		const late = rejection(
			bindIdempotency(a, short).run(who, async () => {
				aTook.open();
				await aMayFail.opened;
				throw boom;
			}),
		);
		await aTook.opened;
		await b.del(KEY);
		const bMayFinish = gate();
		const second = bindIdempotency(b, long).run(who, async () => {
			aMayFail.open();
			await bMayFinish.opened;
			return { orderId: 'second', total: 2 };
		});
		expect(await late).toBe(boom);
		// A's release found B's token, and left the key alone.
		expect(await servers.redis.client.hget(KEY, 'state')).toBe('running');
		bMayFinish.open();
		expect((await second).replayed).toBe(false);
	});
});
