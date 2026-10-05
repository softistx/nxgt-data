import { describe, expect, test } from 'bun:test';
import { counted, createOrder, useRedis } from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { GuardError } from '../errors/guard-error';
import { bindIdempotency } from './bind-idempotency';

// A fingerprint is what the request said. Only its SHA-256 is stored, and a
// repeat whose fingerprint differs — or that has one where the first had
// none — is MISMATCH, never a replay of somebody else's result.

const servers = useRedis();
const orders = () => bindIdempotency(servers.redis.client, createOrder);
const who = { user: 'u1', key: 'k1' };
const KEY = 'orders.create:u1/k1';

describe('fingerprints', () => {
	const body = JSON.stringify({ sku: 'A-1', quantity: 2 });

	test('the same key and the same fingerprint replay', async () => {
		await orders().run(who, counted(), { fingerprint: body });
		const again = await orders().run(who, counted(), { fingerprint: body });
		expect(again.replayed).toBe(true);
	});

	test('bytes and the same text are the same fingerprint, however the view is cut', async () => {
		await orders().run(who, counted(), { fingerprint: body });
		const bytes = new TextEncoder().encode(`xx${body}yy`);
		const view = new DataView(bytes.buffer, 2, bytes.byteLength - 4);
		const again = await orders().run(who, counted(), { fingerprint: view });
		expect(again.replayed).toBe(true);
	});

	test('stores a SHA-256, never the fingerprint itself', async () => {
		await orders().run(who, counted(), { fingerprint: body });
		const fp = await servers.redis.client.hget(KEY, 'fp');
		expect(fp).toBe(new Bun.CryptoHasher('sha256').update(body).digest('hex'));
	});

	test('the same key with a different fingerprint is MISMATCH, and the work is not called', async () => {
		await orders().run(who, counted(), { fingerprint: body });
		const work = counted();
		const error = await rejection(
			orders().run(who, work, { fingerprint: `${body} ` }),
		);
		expect(error).toBeInstanceOf(GuardError);
		expect(error).toMatchObject({
			code: 'MISMATCH',
			definition: 'orders.create',
		});
		expect(work.calls).toBe(0);
	});

	test('no fingerprint first and one after is MISMATCH, and so is the reverse', async () => {
		await orders().run(who, counted());
		const late = await rejection(
			orders().run(who, counted(), { fingerprint: body }),
		);
		expect(late).toMatchObject({ code: 'MISMATCH' });

		const other = { user: 'u1', key: 'k2' };
		await orders().run(other, counted(), { fingerprint: body });
		const dropped = await rejection(orders().run(other, counted()));
		expect(dropped).toMatchObject({ code: 'MISMATCH' });
	});

	test('an empty fingerprint is a fingerprint, not none', async () => {
		await orders().run(who, counted(), { fingerprint: '' });
		const none = await rejection(orders().run(who, counted()));
		expect(none).toMatchObject({ code: 'MISMATCH' });
	});

	test('a fingerprint of another type is a TypeError, and nothing is taken', async () => {
		const fingerprint = 42 as unknown as string;
		const error = await rejection(
			orders().run(who, counted(), { fingerprint }),
		);
		expect(error).toBeInstanceOf(TypeError);
		expect(await servers.redis.client.exists(KEY)).toBe(false);
	});
});
