import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { createOrder, useRedis } from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { GuardError } from '../errors/guard-error';
import { bindIdempotency } from './bind-idempotency';
import { defineIdempotency } from './define-idempotency';

// Two runs of one key at once. Two clients are two connections, as two
// processes would have: Bun pipelines one client's commands in order, so a
// race on one client alone could pass with a take that is not atomic.

const servers = useRedis();
const clients: RedisClient[] = [];

beforeAll(async () => {
	for (let i = 0; i < 2; i += 1) {
		const client = new RedisClient(servers.redis.uri);
		await client.connect();
		clients.push(client);
	}
});

afterAll(() => {
	for (const client of clients.splice(0)) client.close();
});

function pair<D extends typeof createOrder>(definition: D) {
	const [a, b] = clients;
	if (!a || !b) throw new Error('two clients expected');
	return [
		bindIdempotency(a, definition),
		bindIdempotency(b, definition),
	] as const;
}

/** A promise with its resolver outside, for work that waits to be let go. */
function gate() {
	let open = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

const who = { user: 'u1', key: 'k1' };

/** Waits, bounded, until the key is gone — the lease lapsed. */
async function untilGone(key: string) {
	for (let i = 0; i < 400; i += 1) {
		if (!(await servers.redis.client.exists(key))) return;
		await Bun.sleep(5);
	}
	throw new Error('the key never lapsed');
}

describe('while a run is pending', () => {
	test('another client’s run is IN_PROGRESS, with retryAfter the lease left', async () => {
		const [a, b] = pair(createOrder);
		const { opened, open } = gate();
		let started = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		const first = a.run(who, async () => {
			started();
			await opened;
			return { orderId: 'o1', total: 1 };
		});
		await running;

		let calls = 0;
		const error = await rejection(
			b.run(who, () => {
				calls += 1;
				return { orderId: 'o2', total: 2 };
			}),
		);
		expect(error).toBeInstanceOf(GuardError);
		expect(error).toMatchObject({
			code: 'IN_PROGRESS',
			definition: 'orders.create',
		});
		const retryAfter = (error as GuardError).retryAfter ?? 0;
		expect(retryAfter).toBeGreaterThan(0);
		expect(retryAfter).toBeLessThanOrEqual(5000);
		expect(calls).toBe(0);

		open();
		expect((await first).replayed).toBe(false);
		const after = await b.run(who, () => ({ orderId: 'o2', total: 2 }));
		expect(after).toEqual({
			value: { orderId: 'o1', total: 1, status: 'placed' },
			replayed: true,
		});
	});

	test('a different fingerprint is MISMATCH even while it runs', async () => {
		const [a, b] = pair(createOrder);
		const { opened, open } = gate();
		const took = gate();
		const first = a.run(
			who,
			async () => {
				took.open();
				await opened;
				return { orderId: 'o1', total: 1 };
			},
			{ fingerprint: 'body one' },
		);
		await took.opened;

		const error = await rejection(
			b.run(who, () => ({ orderId: 'o2', total: 2 }), {
				fingerprint: 'body two',
			}),
		);
		expect(error).toMatchObject({ code: 'MISMATCH' });
		open();
		await first;
	});

	test('twenty runs at once over two clients call the work exactly once', async () => {
		const [a, b] = pair(createOrder);
		let calls = 0;
		const work = async () => {
			calls += 1;
			await Bun.sleep(20);
			return { orderId: 'o1', total: 1 };
		};
		const settled = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				(i % 2 === 0 ? a : b).run(who, work).then(
					(result) => ({ result }),
					(error: unknown) => ({ error }),
				),
			),
		);
		expect(calls).toBe(1);
		const ran = settled.filter((s) => 'result' in s && !s.result.replayed);
		const refused = settled.filter((s) => 'error' in s);
		expect(ran).toHaveLength(1);
		for (const s of refused)
			expect(s).toMatchObject({ error: { code: 'IN_PROGRESS' } });
		// The rest replayed, if any arrived after it finished.
		expect(settled.length - ran.length - refused.length).toBeGreaterThanOrEqual(
			0,
		);
	});
});

describe('when the lease lapses', () => {
	const short = defineIdempotency({
		...createOrder,
		name: 'orders.short',
		lease: 30,
	});
	// The same operation, as a second process holding it for longer: B must
	// still hold the key when A, whose lease lapsed, tries to store.
	const long = defineIdempotency({ ...short, lease: 5_000 });
	const SHORT_KEY = 'orders.short:u1/k1';

	test('a run that outlasts its lease gets LEASE_LOST, and stores nothing', async () => {
		const [a] = pair(short);
		const error = await rejection(
			a.run(who, async () => {
				await untilGone(SHORT_KEY);
				return { orderId: 'o1', total: 1 };
			}),
		);
		expect(error).toMatchObject({
			code: 'LEASE_LOST',
			definition: 'orders.short',
		});
		expect((error as Error).message).toBe(
			'run on "orders.short": the work outlasted its lease of 30ms, so a repeat may have run it too; its result was not stored',
		);
		expect(await servers.redis.client.exists(SHORT_KEY)).toBe(false);
	});

	test('a repeat after the lapse runs again, and the late run cannot overwrite it', async () => {
		const [a] = pair(short);
		const [, b] = pair(long);
		const aTook = gate();
		const aMayFinish = gate();
		const late = rejection(
			a.run(who, async () => {
				aTook.open();
				await aMayFinish.opened;
				return { orderId: 'late', total: 1 };
			}),
		);
		await aTook.opened;
		await untilGone(SHORT_KEY);
		// B takes the lapsed key and holds it while A tries to store.
		const bMayFinish = gate();
		const second = b.run(who, async () => {
			aMayFinish.open();
			await bMayFinish.opened;
			return { orderId: 'second', total: 2 };
		});
		expect(await late).toMatchObject({ code: 'LEASE_LOST' });
		bMayFinish.open();
		expect((await second).value.orderId).toBe('second');
		// B's result, not A's, is what replays.
		const replay = await b.run(who, () => ({ orderId: 'third', total: 3 }));
		expect(replay).toEqual({
			value: { orderId: 'second', total: 2, status: 'placed' },
			replayed: true,
		});
	});

	test('a late failure cannot release the key another run has taken since', async () => {
		const [a] = pair(short);
		const [, b] = pair(long);
		const aTook = gate();
		const aMayFail = gate();
		const boom = new Error('late failure');
		const late = rejection(
			a.run(who, async () => {
				aTook.open();
				await aMayFail.opened;
				throw boom;
			}),
		);
		await aTook.opened;
		await untilGone(SHORT_KEY);
		const bMayFinish = gate();
		const second = b.run(who, async () => {
			aMayFail.open();
			await bMayFinish.opened;
			return { orderId: 'second', total: 2 };
		});
		expect(await late).toBe(boom);
		// A's release found B's token, and left the key alone.
		expect(await servers.redis.client.hget(SHORT_KEY, 'state')).toBe('running');
		bMayFinish.open();
		expect((await second).replayed).toBe(false);
	});
});
