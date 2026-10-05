import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
	chargeCard,
	counted,
	createOrder,
	useRedis,
} from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { GuardError } from '../errors/guard-error';
import { bindIdempotency } from './bind-idempotency';
import { defineIdempotency } from './define-idempotency';

const servers = useRedis();
const orders = () => bindIdempotency(servers.redis.client, createOrder);
const who = { user: 'u1', key: 'k1' };
const KEY = 'orders.create:u1/k1';
const placed = { orderId: 'o1', total: 1250, status: 'placed' };

describe('run', () => {
	test('runs the work once, and a repeat replays it without calling it', async () => {
		const work = counted();
		const first = await orders().run(who, work);
		const again = await orders().run(who, work);
		expect(first).toEqual({ value: placed, replayed: false });
		expect(again).toEqual({ value: placed, replayed: true });
		expect(work.calls).toBe(1);
	});

	test('the output schema’s defaults are applied on the first run and on replays', async () => {
		const first = await orders().run(who, counted());
		const again = await orders().run(who, counted());
		expect(first.value.status).toBe('placed');
		expect(again.value).toEqual(first.value);
		// And what is stored is the output, so a replay needs no default.
		const stored = await servers.redis.client.hget(KEY, 'value');
		expect(JSON.parse(stored ?? 'null')).toEqual(placed);
	});

	test('another key runs its own work', async () => {
		const work = counted();
		await orders().run(who, work);
		const other = await orders().run({ user: 'u1', key: 'k2' }, work);
		expect(other.replayed).toBe(false);
		expect(work.calls).toBe(2);
	});

	test('a thrown error releases the key, passes through as itself, and the next run executes', async () => {
		const boom = new Error('card declined by the network');
		const error = await rejection(
			orders().run(who, () => {
				throw boom;
			}),
		);
		expect(error).toBe(boom);
		expect(await servers.redis.client.exists(KEY)).toBe(false);

		const async = await rejection(
			orders().run(who, async () => Promise.reject(boom)),
		);
		expect(async).toBe(boom);

		const work = counted();
		expect(await orders().run(who, work)).toEqual({
			value: placed,
			replayed: false,
		});
		expect(work.calls).toBe(1);
	});

	test('a failure returned as a union value is replayed like any result', async () => {
		const charges = bindIdempotency(servers.redis.client, chargeCard);
		let calls = 0;
		const declined = () => {
			calls += 1;
			return { ok: false as const, reason: 'insufficient_funds' };
		};
		const first = await charges.run('c1', declined);
		const again = await charges.run('c1', declined);
		expect(first).toEqual({
			value: { ok: false, reason: 'insufficient_funds' },
			replayed: false,
		});
		expect(again).toEqual({ value: first.value, replayed: true });
		expect(calls).toBe(1);
	});

	test('keeps a result for the ttl, in seconds', async () => {
		await orders().run(who, counted());
		const ttl = await servers.redis.client.ttl(KEY);
		expect(ttl).toBeGreaterThan(3590);
		expect(ttl).toBeLessThanOrEqual(3600);
	});

	test('a running key lives for the lease, in milliseconds', async () => {
		let pttl = 0;
		await orders().run(who, async () => {
			pttl = await servers.redis.client.pttl(KEY);
			return { orderId: 'o1', total: 1 };
		});
		expect(pttl).toBeGreaterThan(4900);
		expect(pttl).toBeLessThanOrEqual(5000);
	});

	test('forget drops a result, says whether one was there, and the next run executes', async () => {
		expect(await orders().forget(who)).toBe(false);
		await orders().run(who, counted());
		expect(await orders().forget(who)).toBe(true);
		const work = counted('o2');
		expect((await orders().run(who, work)).value.orderId).toBe('o2');
		expect(work.calls).toBe(1);
	});

	test('the first caller gets what a replay gets, even from a transform that is not a fixed point', async () => {
		// work returns 1; the schema gives 2, which is stored; a replay parses
		// that 2 and gives 3. Returning the first parse would hand the first
		// caller 2 and everyone after it 3.
		const bumped = defineIdempotency({
			name: 'bumped',
			key: (id: string) => id,
			ttl: 60,
			schema: z.number().transform((n) => n + 1),
		});
		const bound = bindIdempotency(servers.redis.client, bumped);
		const first = await bound.run('n1', () => 1);
		const again = await bound.run('n1', () => 1);
		expect(again.replayed).toBe(true);
		expect(first.replayed).toBe(false);
		expect(first.value).toBe(again.value);
		expect(first.value).toBe(3);
	});
});

describe('INVALID', () => {
	test('a result the schema refuses is not stored, and the key is released', async () => {
		const wrong = () =>
			({ orderId: 7, total: 'lots' }) as unknown as {
				orderId: string;
				total: number;
			};
		const error = await rejection(orders().run(who, wrong));
		expect(error).toBeInstanceOf(GuardError);
		expect(error).toMatchObject({
			code: 'INVALID',
			definition: 'orders.create',
		});
		expect((error as Error).message).toBe(
			'run on "orders.create": the result does not match the schema, so it was not stored (invalid_type)',
		);
		expect(await servers.redis.client.exists(KEY)).toBe(false);
		expect((await orders().run(who, counted())).replayed).toBe(false);
	});

	test('a result that would not survive JSON is refused before it is stored', async () => {
		const dated = defineIdempotency({
			name: 'dated',
			key: (id: string) => id,
			ttl: 60,
			schema: z.object({ at: z.date() }),
		});
		const bound = bindIdempotency(servers.redis.client, dated);
		const error = await rejection(bound.run('d1', () => ({ at: new Date() })));
		expect((error as Error).message).toBe(
			'run on "dated": the result does not match the schema once stored as JSON, so it was not stored (invalid_type)',
		);
		expect(await servers.redis.client.exists('dated:d1')).toBe(false);

		const big = defineIdempotency({
			...dated,
			name: 'big',
			schema: z.bigint(),
		});
		const none = await rejection(
			bindIdempotency(servers.redis.client, big).run('b1', () => 1n),
		);
		expect((none as Error).message).toBe(
			'run on "big": the result has no JSON form, so it was not stored',
		);
		expect(await servers.redis.client.exists('big:b1')).toBe(false);
	});

	test('a stored result the schema now refuses is INVALID, the key is kept, and the work is not called', async () => {
		await orders().run(who, counted());
		// A later deploy's schema, stricter than the one that stored it.
		const stricter = defineIdempotency({
			...createOrder,
			schema: z.object({
				orderId: z.string(),
				total: z.number(),
				currency: z.string(),
			}),
		});
		let calls = 0;
		const work = () => {
			calls += 1;
			return { orderId: 'o2', total: 1, currency: 'EUR' };
		};
		const error = await rejection(
			bindIdempotency(servers.redis.client, stricter).run(who, work),
		);
		expect((error as Error).message).toBe(
			'run on "orders.create": the stored result no longer matches the schema, and the work was not run again (invalid_type)',
		);
		expect(calls).toBe(0);
		expect(await servers.redis.client.hget(KEY, 'state')).toBe('done');
	});
});

describe('messages', () => {
	test('carry no key, no fingerprint and no value', async () => {
		const secret = 'ssn-078-05-1120';
		const params = { user: secret, key: secret };
		const client = servers.redis.client;
		const messages: string[] = [];
		const hold = async (p: Promise<unknown>) => {
			const error = await rejection(p);
			messages.push((error as Error).message);
		};
		await orders().run(params, counted(), { fingerprint: secret });
		await hold(orders().run(params, counted(), { fingerprint: `${secret}!` }));
		const strict = defineIdempotency({
			...createOrder,
			name: 'strict',
			schema: z.strictObject({ orderId: z.string(), total: z.number() }),
		});
		const leaky = () => ({ orderId: secret, total: 1, [secret]: secret });
		await hold(bindIdempotency(client, strict).run(params, leaky));
		await client.hset(`strict:${secret}/${secret}`, {
			state: 'done',
			fp: '',
			value: JSON.stringify({ orderId: 1, [secret]: secret }),
		});
		await client.expire(`strict:${secret}/${secret}`, 60);
		await hold(bindIdempotency(client, strict).run(params, counted()));
		expect(messages).toHaveLength(3);
		for (const message of messages) {
			expect(message).not.toContain(secret);
			expect(message).toStartWith('run on "');
		}
	});
});
