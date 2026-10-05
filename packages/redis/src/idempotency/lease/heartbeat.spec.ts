import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { RedisClient } from 'bun';
import {
	createOrder,
	gate,
	useClients,
	useRedis,
} from '../../../test/fixtures';
import { rejection } from '../../../test/rejection';
import { bindIdempotency } from '../bind-idempotency';
import { defineIdempotency } from '../define-idempotency';

// The lease is renewed every third of it while `work` runs, and the renewals
// stop when `run` settles, whichever way it does. What happens when the key
// is taken from a run is in `lost.spec.ts`.

const servers = useRedis();
const clients = useClients(servers);
const who = { user: 'u1', key: 'k1' };

/** 300 ms, renewed every 100 ms: long enough for a loaded runner's timers. */
const slow = defineIdempotency({ ...createOrder, name: 'slow', lease: 300 });
const SLOW_KEY = 'slow:u1/k1';

/** 60 ms, renewed every 20 ms: many beats in a short test. */
const quick = defineIdempotency({ ...createOrder, name: 'quick', lease: 60 });
const QUICK_KEY = 'quick:u1/k1';

/** Every script this server has run, from `INFO commandstats`. */
async function scriptCalls(client: RedisClient): Promise<number> {
	const info = await client.info('commandstats');
	let calls = 0;
	for (const [, n] of info.matchAll(/cmdstat_eval(?:sha)?:calls=(\d+)/g)) {
		calls += Number(n);
	}
	return calls;
}

/** Waits six beats of `quick`, and says whether any script ran meanwhile. */
async function renewedAfter(): Promise<boolean> {
	const before = await scriptCalls(servers.redis.client);
	await Bun.sleep(120);
	return (await scriptCalls(servers.redis.client)) !== before;
}

describe('the heartbeat', () => {
	test('work lasting three times the lease runs once: a repeat meanwhile is IN_PROGRESS, then replays', async () => {
		const [a, b] = clients();
		let calls = 0;
		const took = gate();
		const running = bindIdempotency(a, slow).run(who, async () => {
			calls += 1;
			took.open();
			await Bun.sleep(900);
			return { orderId: 'o1', total: 1 };
		});
		await took.opened;
		await Bun.sleep(600);
		// Twice the lease in, the key is still this run's, renewed.
		const pttl = await servers.redis.client.pttl(SLOW_KEY);
		expect(pttl).toBeGreaterThan(0);
		expect(pttl).toBeLessThanOrEqual(300);
		const repeat = bindIdempotency(b, slow);
		const busy = await rejection(
			repeat.run(who, () => ({ orderId: 'o2', total: 2 })),
		);
		expect(busy).toMatchObject({ code: 'IN_PROGRESS', definition: 'slow' });

		expect(await running).toEqual({
			value: { orderId: 'o1', total: 1, status: 'placed' },
			replayed: false,
		});
		const replay = await repeat.run(who, () => ({ orderId: 'o2', total: 2 }));
		expect(replay).toEqual({
			value: { orderId: 'o1', total: 1, status: 'placed' },
			replayed: true,
		});
		expect(calls).toBe(1);
	});

	test('stops after a success: the key keeps the ttl, and nothing renews it', async () => {
		const bound = bindIdempotency(servers.redis.client, quick);
		await bound.run(who, async () => {
			await Bun.sleep(100);
			return { orderId: 'o1', total: 1 };
		});
		expect(await renewedAfter()).toBe(false);
		const ttl = await servers.redis.client.ttl(QUICK_KEY);
		expect(ttl).toBeGreaterThan(3590);
		expect(ttl).toBeLessThanOrEqual(3600);
	});

	test('stops after a throw: the key is gone, and nothing renews it', async () => {
		const bound = bindIdempotency(servers.redis.client, quick);
		const boom = new Error('declined');
		const error = await rejection(
			bound.run(who, async () => {
				await Bun.sleep(100);
				throw boom;
			}),
		);
		expect(error).toBe(boom);
		expect(await renewedAfter()).toBe(false);
		expect(await servers.redis.client.exists(QUICK_KEY)).toBe(false);
	});

	test('stops after LEASE_LOST: the key is gone, and nothing renews it', async () => {
		const bound = bindIdempotency(servers.redis.client, quick);
		const error = await rejection(
			bound.run(who, async () => {
				await bound.forget(who);
				await Bun.sleep(100);
				return { orderId: 'o1', total: 1 };
			}),
		);
		expect(error).toMatchObject({ code: 'LEASE_LOST' });
		expect(await renewedAfter()).toBe(false);
		expect(await servers.redis.client.exists(QUICK_KEY)).toBe(false);
	});

	test('leaves no timer to keep the process alive', async () => {
		// A process of its own: three runs, settling each way, then the client
		// closed. An interval nobody cleared would keep it from exiting.
		const script = join(import.meta.dir, '../../../test/exit.ts');
		const child = Bun.spawn([process.execPath, script, servers.redis.uri], {
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const exited = await Promise.race([
			child.exited,
			Bun.sleep(5_000).then(() => 'still running' as const),
		]);
		if (exited === 'still running') child.kill();
		expect(exited).toBe(0);
		expect(await new Response(child.stdout).text()).toBe('settled\n');
	}, 10_000);

	test('a renewal cut off from Redis is tried again at the next beat, and the run stores', async () => {
		// 1.5 s, renewed every 500 ms. The second client pauses writes before
		// the first beat, so A's renewal — a script, which may write — is held
		// on the server; killing A's connection then fails it with "Connection
		// closed" (measured 5/5 on bun 1.4.2, Redis 7.4.1). Bun reconnects in
		// about 50 ms, and the beat at 1 s must renew, or the key lapses at
		// 1.5 s, before the work ends at 1.7 s.
		const [a, b] = clients();
		const steady = defineIdempotency({
			...createOrder,
			name: 'steady',
			lease: 1_500,
		});
		const id = await a.send('CLIENT', ['ID']);
		const result = await bindIdempotency(a, steady).run(who, async () => {
			await b.send('CLIENT', ['PAUSE', '700', 'WRITE']);
			await Bun.sleep(600);
			await b.send('CLIENT', ['KILL', 'ID', String(id)]);
			await Bun.sleep(1_100);
			return { orderId: 'o1', total: 1 };
		});
		expect(result).toEqual({
			value: { orderId: 'o1', total: 1, status: 'placed' },
			replayed: false,
		});
		expect(await servers.redis.client.hget('steady:u1/k1', 'state')).toBe(
			'done',
		);
	});

	test('work that blocks the event loop for longer than the lease loses it, as nothing could renew it', async () => {
		const short = defineIdempotency({
			...createOrder,
			name: 'short',
			lease: 30,
		});
		const bound = bindIdempotency(servers.redis.client, short);
		const error = await rejection(
			bound.run(who, () => {
				Bun.sleepSync(200);
				return { orderId: 'o1', total: 1 };
			}),
		);
		expect(error).toMatchObject({ code: 'LEASE_LOST', definition: 'short' });
		expect((error as Error).message).toBe(
			'run on "short": the key was taken from this run before it finished ' +
				'(forgotten, or its lease of 30ms went unrenewed), so a repeat may ' +
				'have run it too; its result was not stored',
		);
		expect(await servers.redis.client.exists('short:u1/k1')).toBe(false);
	});
});
