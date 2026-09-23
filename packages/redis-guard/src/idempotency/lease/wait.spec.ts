import { describe, expect, test } from 'bun:test';
import {
	counted,
	createOrder,
	gate,
	settled,
	useClients,
	useRedis,
} from '../../../test/fixtures';
import { rejection } from '../../../test/rejection';
import { bindIdempotency } from '../bind-idempotency';

// `wait`: a repeat that finds the key running polls it again, until it is
// done (a replay), free (the repeat runs `work`), or the time is spent
// (IN_PROGRESS). The first run is on one client and the waiter on another.

const servers = useRedis();
const clients = useClients(servers);
const who = { user: 'u1', key: 'k1' };
const KEY = 'orders.create:u1/k1';
const placed = { orderId: 'o1', total: 1250, status: 'placed' };

/** A first run on client A that holds the key until `open` is called. */
function holding(
	outcome: () => { orderId: string; total: number },
	fingerprint?: string,
) {
	const [a] = clients();
	const took = gate();
	const mayFinish = gate();
	const first = settled(
		bindIdempotency(a, createOrder).run(
			who,
			async () => {
				took.open();
				await mayFinish.opened;
				return outcome();
			},
			fingerprint === undefined ? undefined : { fingerprint },
		),
	);
	return { first, took: took.opened, open: mayFinish.open };
}

const waiter = () => bindIdempotency(clients()[1], createOrder);

describe('wait', () => {
	test('sees the first run finish, and replays its result without calling work', async () => {
		const held = holding(() => ({ orderId: 'o1', total: 1250 }));
		await held.took;
		const work = counted('o2');
		const waiting = settled(waiter().run(who, work, { wait: 5_000 }));
		await Bun.sleep(100);
		held.open();
		expect(await waiting).toEqual({ value: { value: placed, replayed: true } });
		expect(work.calls).toBe(0);
		expect(await held.first).toEqual({
			value: { value: placed, replayed: false },
		});
	});

	test('sees the first run give the key back, and runs work itself', async () => {
		const boom = new Error('first failed');
		const held = holding(() => {
			throw boom;
		});
		await held.took;
		const work = counted('o2');
		const waiting = settled(waiter().run(who, work, { wait: 5_000 }));
		await Bun.sleep(100);
		held.open();
		expect(await held.first).toEqual({ error: boom });
		expect(await waiting).toEqual({
			value: { value: { ...placed, orderId: 'o2' }, replayed: false },
		});
		expect(work.calls).toBe(1);
	});

	test('runs out, and rejects with IN_PROGRESS as without it', async () => {
		const held = holding(() => ({ orderId: 'o1', total: 1250 }));
		await held.took;
		const work = counted('o2');
		const started = performance.now();
		// Bounded here rather than by the test's timeout, so a wait that never
		// ends fails this test alone: the first run is let go either way, and
		// both runs settle before any assertion — a waiter still polling when
		// the next test empties Redis would take that test's key.
		const waiting = settled(waiter().run(who, work, { wait: 400 }));
		const outcome = await Promise.race([
			waiting,
			Bun.sleep(1_500).then(() => ({ error: 'still waiting' })),
		]);
		const elapsed = performance.now() - started;
		held.open();
		const first = await held.first;
		await waiting;
		const error = 'error' in outcome ? outcome.error : outcome.value;
		expect(error).toMatchObject({
			code: 'IN_PROGRESS',
			definition: 'orders.create',
		});
		expect((error as { retryAfter?: number }).retryAfter).toBeGreaterThan(0);
		// The pauses are 25, 50, 100 and 200 ms: 375 ms in, 25 are left and the
		// next pause would be 250. Capped at what is left, the wait ends near
		// 400 ms; uncapped, near 625. 550 leaves 150 ms for a loaded runner.
		expect(elapsed).toBeGreaterThanOrEqual(395);
		expect(elapsed).toBeLessThan(550);
		expect(work.calls).toBe(0);
		expect(first).toMatchObject({ value: { replayed: false } });
	});

	test('a different fingerprint is MISMATCH at once, not after the wait', async () => {
		const held = holding(() => ({ orderId: 'o1', total: 1250 }), 'body one');
		await held.took;
		const started = performance.now();
		const error = await rejection(
			waiter().run(who, counted(), { wait: 10_000, fingerprint: 'body two' }),
		);
		expect(error).toMatchObject({ code: 'MISMATCH' });
		expect(performance.now() - started).toBeLessThan(1_000);
		held.open();
		await held.first;
	});

	const midWait: [string, Record<string, string>, string][] = [
		[
			'another fingerprint',
			{ state: 'running', token: 'f'.repeat(32), fp: 'b'.repeat(64) },
			'MISMATCH',
		],
		[
			'a record run could not have written',
			{ state: 'paused', token: 'f'.repeat(32), fp: '' },
			'INVALID',
		],
	];
	for (const [what, fields, code] of midWait) {
		test(`${what}, found mid-wait, is ${code} at once`, async () => {
			const held = holding(() => ({ orderId: 'o1', total: 1250 }));
			await held.took;
			const waiting = rejection(waiter().run(who, counted(), { wait: 10_000 }));
			await Bun.sleep(60);
			const client = servers.redis.client;
			await client.del(KEY);
			await client.hset(KEY, fields);
			await client.pexpire(KEY, 60_000);
			const replaced = performance.now();
			expect(await waiting).toMatchObject({ code });
			expect(performance.now() - replaced).toBeLessThan(1_000);
			held.open();
			// The first run's key was taken from it.
			expect(await held.first).toMatchObject({ error: { code: 'LEASE_LOST' } });
		});
	}
});

describe('wait refused', () => {
	const refused = [
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		2 ** 53,
		'100',
		null,
	];
	for (const wait of refused) {
		test(`${String(wait)} is a TypeError quoting no value, and nothing is taken`, async () => {
			const work = counted();
			const error = await rejection(
				waiter().run(who, work, { wait: wait as number }),
			);
			expect(error).toBeInstanceOf(TypeError);
			expect((error as Error).message).toBe(
				'run on "orders.create": wait is a whole number of milliseconds, 0 or more',
			);
			expect(work.calls).toBe(0);
			expect(await servers.redis.client.exists(KEY)).toBe(false);
		});
	}

	test('0 is no wait: IN_PROGRESS at once', async () => {
		const held = holding(() => ({ orderId: 'o1', total: 1250 }));
		await held.took;
		const error = await rejection(waiter().run(who, counted(), { wait: 0 }));
		expect(error).toMatchObject({ code: 'IN_PROGRESS' });
		held.open();
		await held.first;
	});
});
