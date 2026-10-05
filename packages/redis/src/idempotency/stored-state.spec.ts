import { describe, expect, test } from 'bun:test';
import { createOrder, useRedis } from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { bindIdempotency } from './bind-idempotency';

// What `run` trusts at its key. A record is used only if `run` could have
// written it; anything else is INVALID, the record is left where it is, and
// the work is not called. Not a free key, which would run the work a second
// time beside whatever the record stood for; not MISMATCH, which would tell
// the client it sent another request when it did not.

const servers = useRedis();
const orders = () => bindIdempotency(servers.redis.client, createOrder);
const who = { user: 'u1', key: 'k1' };
const KEY = 'orders.create:u1/k1';
const TOKEN = 'a'.repeat(32);
const FP = 'b'.repeat(64);
const VALUE = JSON.stringify({ orderId: 'o1', total: 1, status: 'placed' });
const CORRUPT =
	'run on "orders.create": the stored record is not one this package wrote, and the work was not run again';

/** Writes a raw hash, with an expiry unless told not to. */
async function store(fields: Record<string, string>, expire = true) {
	await servers.redis.client.hset(KEY, fields);
	if (expire) await servers.redis.client.expire(KEY, 60);
}

/** Runs once, and says what it rejected with and whether work was called. */
async function attempt() {
	let calls = 0;
	const error = await rejection(
		orders().run(who, () => {
			calls += 1;
			return { orderId: 'o2', total: 2 };
		}),
	);
	return { error, calls };
}

describe('a record run could not have written', () => {
	const cases: [string, Record<string, string>][] = [
		['an unknown state', { state: 'paused', token: TOKEN, fp: '' }],
		['a done record with no value', { state: 'done', fp: '', token: TOKEN }],
		[
			'a running record with a value',
			{ state: 'running', fp: '', value: VALUE },
		],
		[
			'a running record whose token is not 32 hex',
			{ state: 'running', token: 'short', fp: '' },
		],
		[
			'an fp that is neither empty nor 64 hex',
			{ state: 'done', fp: 'abc', value: VALUE },
		],
		['no fp at all', { state: 'done', value: VALUE, extra: '1' }],
		['a missing field', { state: 'done', value: VALUE }],
		['a fourth field', { state: 'done', fp: '', value: VALUE, extra: '1' }],
	];

	for (const [what, fields] of cases) {
		test(`${what} is INVALID, kept, and the work is not called`, async () => {
			await store(fields);
			const { error, calls } = await attempt();
			expect(error).toMatchObject({ code: 'INVALID', message: CORRUPT });
			expect(calls).toBe(0);
			expect(await servers.redis.client.exists(KEY)).toBe(true);
		});
	}

	test('a record with no expiry is INVALID: run always sets one', async () => {
		await store({ state: 'running', token: TOKEN, fp: '' }, false);
		expect((await attempt()).error).toMatchObject({ code: 'INVALID' });
		await store({ state: 'done', fp: '', value: VALUE }, false);
		expect((await attempt()).error).toMatchObject({ code: 'INVALID' });
	});

	test('a done value that is not JSON is INVALID, and the work is not called', async () => {
		await store({ state: 'done', fp: '', value: '{not json' });
		const { error, calls } = await attempt();
		expect(error).toMatchObject({ code: 'INVALID', message: CORRUPT });
		expect(calls).toBe(0);
	});

	test('a well-formed record is trusted: a fingerprint of 64 hex that differs is MISMATCH', async () => {
		await store({ state: 'done', fp: FP, value: VALUE });
		expect((await attempt()).error).toMatchObject({ code: 'MISMATCH' });
	});

	test('a well-formed running record is IN_PROGRESS', async () => {
		await store({ state: 'running', token: TOKEN, fp: '' });
		expect((await attempt()).error).toMatchObject({ code: 'IN_PROGRESS' });
	});

	test('a key of another type fails with Redis’s WRONGTYPE, and forget deletes it', async () => {
		await servers.redis.client.set(KEY, 'somebody else’s');
		const { error, calls } = await attempt();
		expect((error as Error).message).toStartWith('WRONGTYPE');
		expect(calls).toBe(0);
		expect(await orders().forget(who)).toBe(true);
	});

	test('forget clears a corrupt record, and the next run executes', async () => {
		await store({ state: 'paused', token: TOKEN, fp: '' });
		expect(await orders().forget(who)).toBe(true);
		const result = await orders().run(who, () => ({ orderId: 'o3', total: 3 }));
		expect(result.replayed).toBe(false);
	});
});
