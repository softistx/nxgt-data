import { describe, expect, test } from 'bun:test';
import { connectRedis } from '@nxgt/redis';
import * as caches from '../../test/caches';
import * as channels from '../../test/channels';
import { useRedis } from '../../test/fixtures';
import { defineConfig } from '../config/define-config';
import { connectKit } from './connect-kit';

const { servers, track } = useRedis();

const one = () => defineConfig({ uri: servers.redis.uri, caches, channels });

const two = () =>
	defineConfig({
		instances: {
			cache: { uri: servers.redis.uri, prefix: 'c', caches },
			pubsub: { uri: servers.redis.uri, prefix: 'p', channels },
		},
	});

describe('one Redis', () => {
	test('cache and channels are the shortcut to the only instance', async () => {
		const kit = track(await connectKit(one()));
		expect(kit.cache).toBe(kit.instances.default.cache);
		expect(kit.channels).toBe(kit.instances.default.channels);
		expect(kit.clients.default).toBe(kit.instances.default.client);
	});
});

describe('several Redis instances', () => {
	test('each is reached by its own name', async () => {
		const kit = track(await connectKit(two()));
		expect(Object.keys(kit.instances).sort()).toEqual(['cache', 'pubsub']);
		expect(kit.instances.cache.prefix).toBe('c');
		expect(kit.instances.pubsub.prefix).toBe('p');
	});

	test('each only wires what its own instance was given', async () => {
		const kit = track(await connectKit(two()));
		expect(Object.keys(kit.instances.cache.cache).sort()).toEqual([
			'seats',
			'users',
		]);
		expect(Object.keys(kit.instances.cache.channels)).toEqual([]);
		expect(Object.keys(kit.instances.pubsub.channels).sort()).toEqual([
			'created',
			'deleted',
		]);
	});

	test('kit.cache refuses to guess which one is meant', async () => {
		const kit = track(await connectKit(two()));
		expect(() => kit.cache).toThrow(
			'kit.cache: this kit holds 2 Redis instances, and this call lives on ' +
				"one. Name it, as { on: 'cache' }.",
		);
	});

	test('kit.channels refuses the same way', async () => {
		const kit = track(await connectKit(two()));
		expect(() => kit.channels).toThrow(/kit\.channels: this kit holds 2/);
	});

	test('two instances on one URI share a client, as connectRedis does', async () => {
		// `connectRedis` counts holders per URI, so this is one socket, and
		// `close()` gives it back only when the last holder lets go.
		const kit = track(await connectKit(two()));
		expect(kit.clients.cache).toBe(kit.clients.pubsub);
	});
});

describe('lock', () => {
	test('runs the work and gives back what it returned', async () => {
		const kit = track(await connectKit(one()));
		expect(await kit.lock('import', () => 'done')).toBe('done');
	});

	test('puts the instance prefix in front of the lock key', async () => {
		const kit = track(
			await connectKit(
				defineConfig({ uri: servers.redis.uri, prefix: 'myapp', caches }),
			),
		);
		let held: string | null = null;
		await kit.lock('import', async () => {
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
		const kit = track(await connectKit(one()));
		const error = await kit.lock('import', () =>
			kit
				.lock('import', () => 'never', { wait: 0 })
				.then(
					() => undefined,
					(caught: unknown) => caught,
				),
		);
		expect((error as { code: string }).code).toBe('LOCK_HELD');
	});

	test('names the instance when the kit holds several', async () => {
		const kit = track(await connectKit(two()));
		expect(await kit.lock('import', () => 'ok', { on: 'pubsub' })).toBe('ok');
		await expect(kit.lock('import', () => 'ok')).rejects.toThrow(
			/kit\.lock: this kit holds 2 Redis instances/,
		);
	});

	test('an instance this kit does not have is named in the refusal', async () => {
		const kit = track(await connectKit(two()));
		await expect(
			kit.lock('import', () => 'ok', { on: 'nope' as never }),
		).rejects.toThrow(
			'kit.lock: this kit has no instance named "nope". It wires "cache", "pubsub".',
		);
	});
});

describe('opening', () => {
	test('an instance that fails to open closes the ones already open', async () => {
		// Nothing listens on this port, and `autoReconnect: false` is what
		// makes that quick — the sibling's own spec measures the default at
		// about 31 seconds of retries.
		const config = defineConfig({
			instances: {
				first: { uri: servers.redis.uri, caches },
				second: {
					uri: 'redis://127.0.0.1:1',
					clientOptions: { autoReconnect: false },
					channels,
				},
			},
		});
		await expect(connectKit(config)).rejects.toThrow();
		// The first instance's hold was given back on the way out: the URI has
		// no holder left, so this opens a working client rather than the one
		// the failed kit would have kept.
		const reopened = await connectRedis(servers.redis.uri);
		expect((await reopened.ping()).ok).toBe(true);
		await reopened.close();
	});

	test('a configuration built by hand, with neither uri nor client, is named', async () => {
		// `defineConfig` refuses this; `connectKit` takes a `KitConfig`, which
		// a caller can write themselves, and says which instance is wrong.
		const byHand = { instances: { main: { caches } } } as never;
		await expect(connectKit(byHand)).rejects.toThrow(
			'connectKit: instance "main" has neither uri nor client. Give it one.',
		);
	});

	test('the checks run again here, on a configuration built elsewhere', async () => {
		const byHand = {
			instances: { main: { uri: servers.redis.uri } },
		} as never;
		await expect(connectKit(byHand)).rejects.toThrow(
			'connectKit: instance "main" wires no cache and no channel. Pass ' +
				'the module that exports them, or drop the instance.',
		);
	});
});

describe('ping', () => {
	test('answers for every instance, under its name', async () => {
		const kit = track(await connectKit(two()));
		const answered = await kit.ping();
		expect(Object.keys(answered).sort()).toEqual(['cache', 'pubsub']);
		expect(answered.cache.ok).toBe(true);
		expect(answered.pubsub.ok).toBe(true);
	});

	test('answers for a client the configuration handed in', async () => {
		// That client carries no `ping` of its own — `RedisConnection.ping`
		// belongs to what `connectRedis` returned — so this is the kit's copy
		// of it, and a health route reads the same answer either way.
		const held = await connectRedis(servers.redis.uri);
		const kit = await connectKit(
			defineConfig({ client: held.client, caches, channels }),
		);
		const answered = await kit.ping();
		expect(answered.default.ok).toBe(true);
		if (answered.default.ok) {
			expect(answered.default.latencyMs).toBeGreaterThanOrEqual(0);
		}
		await kit.close();
		await held.close();
	});

	test('reports a latency a health route can show', async () => {
		const kit = track(await connectKit(one()));
		const answered = await kit.ping();
		expect(answered.default.ok).toBe(true);
		if (answered.default.ok) {
			expect(answered.default.latencyMs).toBeGreaterThanOrEqual(0);
		}
	});
});

describe('close', () => {
	test('gives back a client the kit opened', async () => {
		const kit = await connectKit(one());
		await kit.close();
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
		const kit = await connectKit(two());
		await kit.close();
		const reopened = await connectRedis(servers.redis.uri);
		expect((await reopened.ping()).ok).toBe(true);
		await reopened.close();
	});

	test('never closes a client the configuration handed in', async () => {
		// What it did not open is not its to close: an application that shares
		// one client with something else keeps it after the kit is gone.
		const held = await connectRedis(servers.redis.uri);
		const kit = await connectKit(
			defineConfig({ client: held.client, caches, channels }),
		);
		await kit.close();
		await held.client.set('still', 'here');
		expect(await held.client.get('still')).toBe('here');
		await held.close();
	});
});
