import { describe, expect, test } from 'bun:test';
import { useRedis } from '../../test/fixtures';
import { rejection, rejectionMessage } from '../../test/rejection';
import * as caches from '../../test/wiring/caches';
import * as channels from '../../test/wiring/channels';
import { connectRedis } from '../connection/connect';
import { defineRedis } from './config/define-redis';
import { openRedis } from './open-redis';

const servers = useRedis();
const { track } = servers;

const one = () => defineRedis({ uri: servers.redis.uri, caches, channels });

const two = () =>
	defineRedis({
		instances: {
			cache: { uri: servers.redis.uri, prefix: 'c', caches },
			pubsub: { uri: servers.redis.uri, prefix: 'p', channels },
		},
	});

describe('one Redis', () => {
	test('cache and channels are the shortcut to the only instance', async () => {
		const redis = track(await openRedis(one()));
		expect(redis.cache).toBe(redis.instances.default.cache);
		expect(redis.channels).toBe(redis.instances.default.channels);
		expect(redis.clients.default).toBe(redis.instances.default.client);
	});
});

describe('several Redis instances', () => {
	test('each is reached by its own name', async () => {
		const redis = track(await openRedis(two()));
		expect(Object.keys(redis.instances).sort()).toEqual(['cache', 'pubsub']);
		expect(redis.instances.cache.prefix).toBe('c');
		expect(redis.instances.pubsub.prefix).toBe('p');
	});

	test('each only wires what its own instance was given', async () => {
		const redis = track(await openRedis(two()));
		expect(Object.keys(redis.instances.cache.cache).sort()).toEqual([
			'seats',
			'users',
		]);
		expect(Object.keys(redis.instances.cache.channels)).toEqual([]);
		expect(Object.keys(redis.instances.pubsub.channels).sort()).toEqual([
			'created',
			'deleted',
		]);
	});

	test('redis.cache refuses to guess which one is meant', async () => {
		const redis = track(await openRedis(two()));
		expect(() => redis.cache).toThrow(
			'cache: this Redis holds 2 Redis instances, and this call lives on ' +
				"one. Name it, as { on: 'cache' }.",
		);
	});

	test('redis.channels refuses the same way', async () => {
		const redis = track(await openRedis(two()));
		expect(() => redis.channels).toThrow(/channels: this Redis holds 2/);
	});

	test('two instances on one URI share a client, as connectRedis does', async () => {
		// `connectRedis` counts holders per URI, so this is one socket, and
		// `close()` gives it back only when the last holder lets go.
		const redis = track(await openRedis(two()));
		expect(redis.clients.cache).toBe(redis.clients.pubsub);
	});
});

describe('lock', () => {
	test('runs the work and gives back what it returned', async () => {
		const redis = track(await openRedis(one()));
		expect(await redis.lock('import', () => 'done')).toBe('done');
	});

	test('puts the instance prefix in front of the lock key', async () => {
		const redis = track(
			await openRedis(
				defineRedis({ uri: servers.redis.uri, prefix: 'myapp', caches }),
			),
		);
		let held: string | null = null;
		await redis.lock('import', async () => {
			held = await servers.redis.client.get('lock:myapp:import');
		});
		expect(held).not.toBeNull();
		// Inside `lock:`, not in front of it: `withLock` writes `lock:${key}`
		// itself, and this package does not reach into a sibling to reorder
		// it. Two deployments are still kept apart, which is the point.
		expect(await servers.redis.client.get('myapp:lock:import')).toBeNull();
		// And it is given back at the end.
		expect(await servers.redis.client.get('lock:myapp:import')).toBeNull();
	});

	test('a second holder is refused while the first has it', async () => {
		const redis = track(await openRedis(one()));
		const error = await redis.lock('import', () =>
			redis
				.lock('import', () => 'never', { wait: 0 })
				.then(
					() => undefined,
					(caught: unknown) => caught,
				),
		);
		expect((error as { code: string }).code).toBe('LOCK_HELD');
	});

	test('names the instance when the Redis holds several', async () => {
		const redis = track(await openRedis(two()));
		expect(await redis.lock('import', () => 'ok', { on: 'pubsub' })).toBe('ok');
		expect(await rejectionMessage(redis.lock('import', () => 'ok'))).toMatch(
			/lock: this Redis holds 2 Redis instances/,
		);
	});

	test('an instance this Redis does not have is named in the refusal', async () => {
		const redis = track(await openRedis(two()));
		expect(
			await rejectionMessage(
				redis.lock('import', () => 'ok', { on: 'nope' as never }),
			),
		).toContain(
			'lock: this Redis has no instance named "nope". It wires "cache", "pubsub".',
		);
	});
});

describe('opening', () => {
	test('an instance that fails to open closes the ones already open', async () => {
		// Nothing listens on this port, and `autoReconnect: false` is what
		// makes that quick — the sibling's own spec measures the default at
		// about 31 seconds of retries.
		const config = defineRedis({
			instances: {
				first: { uri: servers.redis.uri, caches },
				second: {
					uri: 'redis://127.0.0.1:1',
					clientOptions: { autoReconnect: false },
					channels,
				},
			},
		});
		await rejection(openRedis(config));
		// The first instance's hold was given back on the way out: the URI has
		// no holder left, so this opens a working client rather than the one
		// the failed Redis would have kept.
		const reopened = await connectRedis(servers.redis.uri);
		expect((await reopened.ping()).ok).toBe(true);
		await reopened.close();
	});

	test('a configuration built by hand, with neither uri nor client, is named', async () => {
		// `defineRedis` refuses this; `openRedis` takes a `RedisConfig`, which
		// a caller can write themselves, and says which instance is wrong.
		const byHand = { instances: { main: { caches } } } as never;
		expect(await rejectionMessage(openRedis(byHand))).toContain(
			'openRedis: instance "main" has neither uri nor client. Give it one.',
		);
	});

	test('the checks run again here, on a configuration built elsewhere', async () => {
		const byHand = {
			instances: { main: { uri: servers.redis.uri } },
		} as never;
		expect(await rejectionMessage(openRedis(byHand))).toContain(
			'openRedis: instance "main" wires no cache, no channel, no rate limit and no idempotency. Pass ' +
				'the module that exports them, or drop the instance.',
		);
	});
});

describe('ping', () => {
	test('answers for every instance, under its name', async () => {
		const redis = track(await openRedis(two()));
		const answered = await redis.ping();
		expect(Object.keys(answered).sort()).toEqual(['cache', 'pubsub']);
		expect(answered.cache.ok).toBe(true);
		expect(answered.pubsub.ok).toBe(true);
	});

	test('answers for a client the configuration handed in', async () => {
		// That client carries no `ping` of its own — `RedisConnection.ping`
		// belongs to what `connectRedis` returned — so this is the Redis's copy
		// of it, and a health route reads the same answer either way.
		const held = await connectRedis(servers.redis.uri);
		const redis = await openRedis(
			defineRedis({ client: held.client, caches, channels }),
		);
		const answered = await redis.ping();
		expect(answered.default.ok).toBe(true);
		if (answered.default.ok) {
			expect(answered.default.latencyMs).toBeGreaterThanOrEqual(0);
		}
		await redis.close();
		await held.close();
	});

	test('reports a latency a health route can show', async () => {
		const redis = track(await openRedis(one()));
		const answered = await redis.ping();
		expect(answered.default.ok).toBe(true);
		if (answered.default.ok) {
			expect(answered.default.latencyMs).toBeGreaterThanOrEqual(0);
		}
	});
});

describe('close', () => {
	test('gives back a client the Redis opened', async () => {
		const redis = await openRedis(one());
		await redis.close();
		// The URI has no holder left, so the next `connectRedis` opens a new
		// socket rather than handing back a closed one.
		const reopened = await connectRedis(servers.redis.uri);
		expect((await reopened.ping()).ok).toBe(true);
		await reopened.close();
	});

	test('gives back both holds when two instances share one URI', async () => {
		// `connectRedis` counts holders per URI, and `two()` takes two of them
		// on one socket. A `close()` that gave back only one would leave the
		// client open with nobody holding it, and nothing else would say so.
		const redis = await openRedis(two());
		await redis.close();
		const reopened = await connectRedis(servers.redis.uri);
		expect((await reopened.ping()).ok).toBe(true);
		await reopened.close();
	});

	test('never closes a client the configuration handed in', async () => {
		// What it did not open is not its to close: an application that shares
		// one client with something else keeps it after the Redis is gone.
		const held = await connectRedis(servers.redis.uri);
		const redis = await openRedis(
			defineRedis({ client: held.client, caches, channels }),
		);
		await redis.close();
		await held.client.set('still', 'here');
		expect(await held.client.get('still')).toBe('here');
		await held.close();
	});
});
