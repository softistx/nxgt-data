import { describe, expect, test } from 'bun:test';
import { defineCache, defineChannel } from '@nxgt/redis';
import { z } from 'zod';
import * as caches from '../../test/caches';
import * as channels from '../../test/channels';
import { defineConfig } from './define-config';

const uri = 'redis://127.0.0.1:6379';

describe('defineConfig', () => {
	test('names a single instance "default", and freezes what it gives back', () => {
		const config = defineConfig({ uri, caches });
		expect(Object.keys(config.instances)).toEqual(['default']);
		expect(config.instances.default.uri).toBe(uri);
		expect(Object.isFrozen(config)).toBe(true);
		expect(Object.isFrozen(config.instances)).toBe(true);
	});

	test('keeps several instances under their own names', () => {
		const config = defineConfig({
			instances: {
				cache: { uri, caches },
				pubsub: { uri: 'redis://127.0.0.1:6380', channels },
			},
		});
		expect(Object.keys(config.instances).sort()).toEqual(['cache', 'pubsub']);
	});

	test('connects to nothing and reads no environment variable', () => {
		// The whole point of the split from `connectKit`: a configuration can
		// be built in a test, in a script, or at the top of a module, without
		// a Redis anywhere.
		const config = defineConfig({ uri: 'redis://nowhere:1', caches });
		expect(config.instances.default.uri).toBe('redis://nowhere:1');
	});

	test('refuses an instance with neither uri nor client', () => {
		expect(() => defineConfig({ caches } as never)).toThrow(
			'defineConfig: instance "default" has neither uri nor client. Give it one.',
		);
	});

	test('refuses an instance with both', () => {
		expect(() => defineConfig({ uri, client: {} as never, caches })).toThrow(
			/instance "default" has both uri and client\. Pass the URI to connect to, or the client you already opened\./,
		);
	});

	test('refuses clientOptions beside a client', () => {
		expect(() =>
			defineConfig({
				client: {} as never,
				clientOptions: {},
				caches,
			}),
		).toThrow(/has clientOptions beside a client/);
	});

	test('refuses an empty prefix, rather than silently writing ":key"', () => {
		expect(() => defineConfig({ uri, prefix: '   ', caches })).toThrow(
			'defineConfig: instance "default" has an empty prefix. Leave it out, or give it a name.',
		);
	});

	test('refuses an instance that wires nothing', () => {
		expect(() => defineConfig({ uri })).toThrow(
			'defineConfig: instance "default" wires no cache and no channel. ' +
				'Pass the module that exports them, or drop the instance.',
		);
	});

	test('refuses an empty instances map', () => {
		expect(() => defineConfig({ instances: {} })).toThrow(
			/`instances` is empty/,
		);
	});

	test('refuses one cache wired twice, which would share every key', () => {
		const one = defineCache({
			name: 'user',
			key: (id: string) => id,
			ttl: 60,
			schema: z.object({ id: z.string() }),
		});
		expect(() =>
			defineConfig({ uri, caches: { users: one, people: one } }),
		).toThrow(
			'defineConfig: instance "default" wires the cache named "user" twice, ' +
				'under "users" and "people". They would share every key in Redis. ' +
				'Export one of them, or give it a name of its own.',
		);
	});

	test('refuses one channel wired twice, the same way', () => {
		const one = defineChannel({
			name: 'user.created',
			schema: z.object({ id: z.string() }),
		});
		expect(() =>
			defineConfig({ uri, channels: { created: one, made: one } }),
		).toThrow(/wires the channel named "user\.created" twice/);
	});

	test('two definitions that only share a key are fine', () => {
		// The refusal is about one definition under two keys, not two
		// definitions under two keys that happen to agree on something else.
		expect(() => defineConfig({ uri, caches, channels })).not.toThrow();
	});

	test('a module that also exports other things is taken as it is', () => {
		// `test/caches.ts` exports a schema, a type and a string beside its two
		// definitions; `test/channels.ts` exports a type. Nothing here has to
		// be filtered by the application.
		expect(() => defineConfig({ uri, caches, channels })).not.toThrow();
	});
});
