import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { RedisClient } from 'bun';
import { z } from 'zod';
import { defineCache } from '../src/cache/define-cache';
import { defineChannel } from '../src/channel/define-channel';
import { closeRedis } from '../src/connection/connect';
import { defineIdempotency } from '../src/idempotency/define-idempotency';
import { defineRateLimit } from '../src/rate-limit/define-rate-limit';
import { GCRA_AT_ARGV, type Rate, toResult } from '../src/rate-limit/gcra';
import { runScript } from '../src/scripts/run-script';
import type { Redis } from '../src/wiring/types';
import { startRedis, type TestServer } from './server';

export const userSchema = z.object({
	id: z.string(),
	email: z.string(),
	seats: z.number().default(1),
});

export type User = z.output<typeof userSchema>;

/** Keyed by a plain id. */
export const userCache = defineCache({
	name: 'user',
	key: (id: string) => id,
	ttl: 60,
	schema: userSchema,
});

/** Keyed by more than one thing, which is why `key` takes an object. */
export const seatCache = defineCache({
	name: 'seat',
	key: (params: { org: string; user: string }) =>
		`${params.org}/${params.user}`,
	ttl: 60,
	schema: z.object({ taken: z.number() }),
});

export const userCreated = defineChannel({
	name: 'user.created',
	schema: userSchema,
});

/**
 * One Redis per spec file, emptied before each test, and every Redis a test
 * opened closed before the server stops.
 *
 * `closeRedis()` runs last: `connectRedis` shares a client per URI, so a
 * connection a test left open would keep one alive past the server. The Redis objects
 * are tracked because a subscription holds a connection duplicated from the
 * client, and one nobody closed would keep the server from stopping.
 */
export function useRedis() {
	const servers = {} as { redis: TestServer; track: <K>(redis: K) => K };
	const opened: Redis<never>[] = [];

	beforeAll(async () => {
		servers.redis = await startRedis();
	}, 120_000);

	beforeEach(async () => {
		await servers.redis.reset();
	});

	afterAll(async () => {
		for (const redis of opened.splice(0))
			await redis.close().catch(() => undefined);
		await closeRedis();
		await servers.redis?.stop();
	});

	/** A Redis this file will close for you when it ends. */
	servers.track = <K>(redis: K): K => {
		opened.push(redis as unknown as Redis<never>);
		return redis;
	};

	return servers;
}

/** Polls `read` until it gives what `expected` is, or fails after a while. */
export async function eventually<T>(
	read: () => Promise<T> | T,
	expected: T,
): Promise<void> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const value = await read();
		if (Bun.deepEquals(value, expected)) return;
		if (Date.now() > deadline) {
			throw new Error(
				`still ${JSON.stringify(value)}, not ${JSON.stringify(expected)}`,
			);
		}
		await Bun.sleep(20);
	}
}

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
 * Two more clients of the spec file's Redis, opened after it starts: two
 * connections, as two processes would have. Bun pipelines one client's
 * commands in order, so a race on one client alone could pass with a step
 * that is not atomic. Call it after `useRedis`, whose server it needs.
 */
export function useClients(servers: { redis: TestServer }) {
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

	/** The first and the second client, for binding one definition twice. */
	return () => {
		const [a, b] = clients;
		if (!a || !b) throw new Error('two clients expected');
		return [a, b] as const;
	};
}

/** A promise with its resolver outside, for work that waits to be let go. */
export function gate() {
	let open = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

/**
 * How a promise settled, taken where it is made — as `rejection` does, for a
 * promise that should resolve but must not reject unheld if it does not.
 */
export function settled<T>(
	promise: Promise<T>,
): Promise<{ value: T } | { error: unknown }> {
	return promise.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
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
