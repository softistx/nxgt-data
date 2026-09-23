import { afterAll, beforeAll, beforeEach } from 'bun:test';
import type { RedisClient } from 'bun';
import { z } from 'zod';
import { defineIdempotency } from '../src/idempotency/define-idempotency';
import { defineRateLimit } from '../src/rate-limit/define-rate-limit';
import { GCRA_AT_ARGV, type Rate, toResult } from '../src/rate-limit/gcra';
import { runScript } from '../src/scripts/run-script';
import { startRedis, type TestServer } from './server';

/** Five a minute per address: the README's example. */
export const loginLimit = defineRateLimit({
	name: 'login',
	key: (params: { ip: string }) => params.ip,
	limit: 5,
	per: 60_000,
});

/**
 * Keyed by more than one thing, with a burst above its rate: ten at once,
 * then one every six seconds.
 */
export const exportLimit = defineRateLimit({
	name: 'export',
	key: (params: { org: string; user: string }) =>
		`${params.org}/${params.user}`,
	limit: 10,
	per: 60_000,
	burst: 20,
});

/**
 * An order placed once per idempotency key: the README's example. `status`
 * has a default, so what `work` returns may leave it out.
 */
export const createOrder = defineIdempotency({
	name: 'orders.create',
	key: (params: { user: string; key: string }) =>
		`${params.user}/${params.key}`,
	ttl: 3600,
	lease: 5_000,
	schema: z.object({
		orderId: z.string(),
		total: z.number().int(),
		status: z.string().default('placed'),
	}),
});

/**
 * A charge whose refusal by the provider is a result too, and replayed: the
 * README's union example.
 */
export const chargeCard = defineIdempotency({
	name: 'payments.charge',
	key: (key: string) => key,
	ttl: 600,
	schema: z.discriminatedUnion('ok', [
		z.object({ ok: z.literal(true), chargeId: z.string() }),
		z.object({ ok: z.literal(false), reason: z.string() }),
	]),
});

/** A `work` for `createOrder` that counts its calls; it leaves `status` out. */
export function counted(orderId = 'o1') {
	const work = () => {
		work.calls += 1;
		return { orderId, total: 1250 };
	};
	work.calls = 0;
	return work;
}

/**
 * One Redis per spec file, emptied before each test. This package opens no
 * client of its own — every call takes the caller's — so the server's own
 * client is the only one to close.
 */
export function useRedis() {
	const servers = {} as { redis: TestServer };

	beforeAll(async () => {
		servers.redis = await startRedis();
	}, 120_000);

	beforeEach(async () => {
		await servers.redis.reset();
	});

	afterAll(async () => {
		await servers.redis?.stop();
	});

	return servers;
}

/**
 * One check by the rate-limit script with `now` given, in microseconds,
 * rather than read from the server: many calls at one instant, or a clock
 * that moves back and forth, with nothing refilling in between.
 */
export async function consumeAt(
	client: RedisClient,
	key: string,
	rate: Rate,
	cost: number,
	now: number,
	write = true,
) {
	const reply = await runScript(
		client,
		GCRA_AT_ARGV,
		[key],
		[rate.per, rate.limit, rate.burst, cost, write ? 1 : 0, now],
	);
	return toResult(reply, rate);
}
