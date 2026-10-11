import { afterEach, describe, expect, test } from 'bun:test';
import {
	counted,
	createOrder,
	useClients,
	useRedis,
} from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { GuardError } from '../errors/guard-error';
import { bindIdempotency } from './bind-idempotency';

// `timeoutMs` on `run`. A Redis that does not answer is made with
// `CLIENT PAUSE … WRITE` from the second client: every script `run` sends is
// held until the pause ends, and then runs. `createOrder`'s lease is 5 s, so
// a key nobody gives back would still be held when each test looks.

const servers = useRedis();
const clients = useClients(servers);
const who = { user: 'u1', key: 'k1' };

// What a test gave up on runs once the pause ends; a `PING` behind it on the
// same client answers only after, so nothing lands after the next `FLUSHALL`.
afterEach(async () => {
	const [a, b] = clients();
	await b.send('CLIENT', ['UNPAUSE']);
	await a.ping();
});

async function pause(ms: number): Promise<void> {
	const [, b] = clients();
	await b.send('CLIENT', ['PAUSE', String(ms), 'WRITE']);
}

describe('taking the key times out', () => {
	test('TIMEOUT, work not called, and the key given back once Redis answers', async () => {
		const [a] = clients();
		const orders = bindIdempotency(a, createOrder);
		const work = counted();
		await pause(300);
		const error = await rejection(orders.run(who, work, { timeoutMs: 50 }));
		expect(error).toBeInstanceOf(GuardError);
		const guard = error as GuardError;
		expect(guard.code).toBe('TIMEOUT');
		expect(guard.definition).toBe('orders.create');
		expect(guard.message).toBe(
			'run on "orders.create": Redis did not answer within 50ms; ' +
				'`work` was not called; a key it took is released',
		);
		expect(guard.message).not.toContain('k1');
		expect(work.calls).toBe(0);

		// The late BEGIN took the key; the release behind it gave it back, so a
		// repeat runs rather than finding it IN_PROGRESS for the 5 s lease.
		await a.ping();
		expect(await a.exists(orders.keyFor(who))).toBe(false);
		const again = await orders.run(who, work);
		expect(again.replayed).toBe(false);
		expect(work.calls).toBe(1);
	});

	test('each poll of wait is bounded too', async () => {
		const [a, b] = clients();
		const first = bindIdempotency(b, createOrder);
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		const holding = first.run(who, async () => {
			started();
			await held;
			return { orderId: 'o1', total: 1 };
		});
		await running;

		const waiting = bindIdempotency(a, createOrder).run(who, counted(), {
			wait: 2_000,
			timeoutMs: 50,
		});
		await Bun.sleep(60);
		await pause(300);
		const error = await rejection(waiting);
		expect((error as GuardError).code).toBe('TIMEOUT');
		await b.send('CLIENT', ['UNPAUSE']);
		release();
		expect((await holding).replayed).toBe(false);
	});
});

describe('storing the result times out', () => {
	test('TIMEOUT after work ran, and a repeat replays the result once it landed', async () => {
		const [a] = clients();
		const orders = bindIdempotency(a, createOrder);
		const work = counted();
		const error = await rejection(
			orders.run(
				who,
				async () => {
					await pause(300);
					return work();
				},
				{ timeoutMs: 50 },
			),
		);
		const guard = error as GuardError;
		expect(guard.code).toBe('TIMEOUT');
		expect(guard.message).toBe(
			'run on "orders.create": Redis did not answer within 50ms; ' +
				'`work` ran, and its result may or may not be stored: a repeat ' +
				'replays it if it was, or runs `work` again once the lease lapses',
		);
		expect(work.calls).toBe(1);

		await a.ping();
		const again = await orders.run(who, work);
		expect(again).toEqual({
			value: { orderId: 'o1', total: 1250, status: 'placed' },
			replayed: true,
		});
		expect(work.calls).toBe(1);
	});
});

describe('giving the key back times out', () => {
	test('the error work threw passes through, not TIMEOUT, and in time', async () => {
		const [a] = clients();
		const orders = bindIdempotency(a, createOrder);
		const thrown = new Error('the provider refused');
		const startedAt = performance.now();
		const error = await rejection(
			orders.run(
				who,
				async () => {
					await pause(400);
					throw thrown;
				},
				{ timeoutMs: 50 },
			),
		);
		expect(error).toBe(thrown);
		expect(performance.now() - startedAt).toBeLessThan(350);
	});
});

describe('a Redis that answers in time', () => {
	test('runs and replays as without a timeout', async () => {
		const orders = bindIdempotency(servers.redis.client, createOrder);
		const work = counted();
		const first = await orders.run(who, work, { timeoutMs: 1_000 });
		const again = await orders.run(who, work, { timeoutMs: 1_000 });
		expect(first.replayed).toBe(false);
		expect(again.replayed).toBe(true);
		expect(work.calls).toBe(1);
	});
});

describe('a timeoutMs that is not a whole number of 1 or more', () => {
	test.each([0, -5, 2.5, Number.NaN, '100'])(
		'%p is a TypeError, before anything is sent',
		async (timeoutMs) => {
			const orders = bindIdempotency(servers.redis.client, createOrder);
			const work = counted();
			const options = { timeoutMs } as unknown as { timeoutMs: number };
			const error = await rejection(orders.run(who, work, options));
			expect(error).toBeInstanceOf(TypeError);
			expect((error as Error).message).toBe(
				'run on "orders.create": timeoutMs is a whole number of milliseconds, 1 or more',
			);
			expect(work.calls).toBe(0);
			expect(await servers.redis.client.exists(orders.keyFor(who))).toBe(false);
		},
	);
});
