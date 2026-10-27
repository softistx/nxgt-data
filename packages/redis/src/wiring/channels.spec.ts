import { describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { eventually, useRedis } from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import * as caches from '../../test/wiring/caches';
import * as channels from '../../test/wiring/channels';
import * as keyed from '../../test/wiring/keyed-channels';
import { connectRedis } from '../connection/connect';
import { RedisError } from '../errors/redis-error';
import { defineRedis } from './config/define-redis';
import { openRedis } from './open-redis';

const servers = useRedis();
const { track } = servers;

const redisOn = async (prefix?: string) =>
	track(
		await openRedis(
			defineRedis({ uri: servers.redis.uri, prefix, caches, channels }),
		),
	);

const keyedOn = async () =>
	track(
		await openRedis(
			defineRedis({
				uri: servers.redis.uri,
				channels: { ...channels, ...keyed },
			}),
		),
	);

const ada = { id: 'ada', email: 'ada@example.com', seats: 1 };

describe('a channel of the Redis', () => {
	test('carries a payload from publish to subscribe', async () => {
		const redis = await redisOn();
		const seen: unknown[] = [];
		await redis.channels.created.subscribe((payload) => {
			seen.push(payload);
		});
		await redis.channels.created.publish(ada);
		await eventually(() => seen.length, 1);
		expect(seen[0]).toEqual(ada);
	});

	test('publishes under the prefixed name, and a plain subscriber sees it there', async () => {
		const redis = await redisOn('myapp:prod');
		const seen: unknown[] = [];
		// Subscribed through the raw client, on the name the prefix produces:
		// proof that the prefix is what actually reaches Redis, not a label.
		const listener = await servers.redis.client.duplicate();
		await listener.connect();
		await listener.subscribe('myapp:prod:user.created', (message: string) => {
			seen.push(JSON.parse(message));
		});
		await redis.channels.created.publish(ada);
		await eventually(() => seen.length, 1);
		expect(seen[0]).toEqual(ada);
		listener.close();
	});

	test('two channels do not hear each other', async () => {
		const redis = await redisOn();
		const created: unknown[] = [];
		const deleted: unknown[] = [];
		await redis.channels.created.subscribe((p) => {
			created.push(p);
		});
		await redis.channels.deleted.subscribe((p) => {
			deleted.push(p);
		});
		await redis.channels.deleted.publish({ id: 'ada' });
		await eventually(() => deleted.length, 1);
		expect(created).toEqual([]);
	});

	test('a payload the schema refuses is a RedisError, from the package itself', async () => {
		const redis = await redisOn();
		const error = await redis.channels.deleted
			.publish({ id: 42 } as never)
			.then(
				() => undefined,
				(caught: unknown) => caught,
			);
		expect((error as Error).name).toBe('RedisError');
		expect((error as { code: string }).code).toBe('INVALID');
	});
});

describe('the subscriptions the Redis keeps', () => {
	test('close() closes the ones nobody closed', async () => {
		const redis = await redisOn();
		const seen: unknown[] = [];
		await redis.channels.created.subscribe((p) => {
			seen.push(p);
		});
		await redis.channels.created.publish(ada);
		await eventually(() => seen.length, 1);

		await redis.close();

		// The Redis is gone; a message published on the same name through the
		// raw client reaches nothing it left behind.
		await servers.redis.client.publish(
			'user.created',
			JSON.stringify({ ...ada, id: 'grace' }),
		);
		await Bun.sleep(100);
		expect(seen).toHaveLength(1);
	});

	test('a subscription closed early is not closed twice by the Redis', async () => {
		const redis = await redisOn();
		const subscription = await redis.channels.created.subscribe(() => {});
		await subscription.close();
		// The Redis forgot it when it was closed, so `close()` has nothing left
		// to do for it — and would be safe either way, since `@nxgt/redis`
		// memoises its own close.
		await redis.close();
		await expect(subscription.close()).resolves.toBeUndefined();
	});

	test('a subscription disposed with await using is forgotten too', async () => {
		const redis = await redisOn();
		const seen: unknown[] = [];
		{
			await using running = await redis.channels.created.subscribe((p) => {
				seen.push(p);
			});
			void running;
			await redis.channels.created.publish(ada);
			await eventually(() => seen.length, 1);
		}
		// Disposed at the end of the block, so the Redis is no longer holding
		// it — and what it publishes next reaches nothing.
		await redis.channels.created.publish(ada);
		await Bun.sleep(100);
		expect(seen).toHaveLength(1);
		await redis.close();
	});

	test('close() takes the subscriptions but leaves a handed-in client open', async () => {
		// The two rules meet here: what the Redis started it closes, and what it
		// did not open it keeps its hands off.
		const held = await connectRedis(servers.redis.uri);
		const redis = await openRedis(
			defineRedis({ client: held.client, caches, channels }),
		);
		const seen: unknown[] = [];
		await redis.channels.created.subscribe((p) => {
			seen.push(p);
		});
		await redis.channels.created.publish(ada);
		await eventually(() => seen.length, 1);

		await redis.close();

		await held.client.publish('user.created', JSON.stringify(ada));
		await Bun.sleep(100);
		expect(seen).toHaveLength(1);
		// Still usable: the Redis closed its subscription, not the client.
		await held.client.set('still', 'here');
		expect(await held.client.get('still')).toBe('here');
		await held.close();
	});

	test('close() is idempotent', async () => {
		const redis = await redisOn();
		await redis.channels.created.subscribe(() => {});
		await redis.close();
		await expect(redis.close()).resolves.toBeUndefined();
	});

	test('await using closes the Redis at the end of the block', async () => {
		const seen: unknown[] = [];
		{
			await using redis = await redisOn();
			await redis.channels.created.subscribe((p) => {
				seen.push(p);
			});
			await redis.channels.created.publish(ada);
			await eventually(() => seen.length, 1);
		}
		await servers.redis.client.publish('user.created', JSON.stringify(ada));
		await Bun.sleep(100);
		expect(seen).toHaveLength(1);
	});

	test('a handler that throws goes to onError, not past the subscription', async () => {
		const redis = await redisOn();
		const errors: unknown[] = [];
		await redis.channels.created.subscribe(
			() => {
				throw new Error('the handler broke');
			},
			{ onError: (error) => errors.push(error) },
		);
		await redis.channels.created.publish(ada);
		await eventually(() => errors.length, 1);
		expect((errors[0] as Error).message).toBe('the handler broke');
	});

	test('stream(key) carries one key through Redis, and return() releases it at once', async () => {
		const redis = await keyedOn();
		const a = redis.channels.changed.stream('a');
		const b = redis.channels.changed.stream('b');
		const first = a.next();
		const other = b.next();
		await Bun.sleep(100); // the shared subscription opens on the first read
		await redis.channels.changed.publish({ id: 'b', n: 2 });
		await redis.channels.changed.publish({ id: 'a', n: 1 });
		expect(await first).toEqual({ value: { id: 'a', n: 1 }, done: false });
		expect(await other).toEqual({ value: { id: 'b', n: 2 }, done: false });
		const idle = a.next();
		expect(await a.return(undefined)).toEqual({ value: undefined, done: true });
		expect(await idle).toEqual({ value: undefined, done: true });
		await b.return(undefined);
		await redis.channels.changed.close();
	});

	test('stream() on a channel defined without a key is a TypeError', async () => {
		const redis = await redisOn();
		expect(() => redis.channels.created.stream('a')).toThrow(TypeError);
	});

	test('redis.close() ends a stream still waiting', async () => {
		const redis = await keyedOn();
		const it = redis.channels.changed.stream('a');
		const idle = it.next();
		await Bun.sleep(100);
		await redis.close();
		expect(await idle).toEqual({ value: undefined, done: true });
	});

	test('a stream asked for after redis.close() is already finished', async () => {
		const redis = await keyedOn();
		await redis.close();
		const it = redis.channels.changed.stream('a');
		expect(await it.next()).toEqual({ value: undefined, done: true });
	});

	test('channel.close() ends its streams, and a later stream() works again', async () => {
		const redis = await keyedOn();
		const old = redis.channels.changed.stream('a');
		const idle = old.next();
		await Bun.sleep(100);
		await redis.channels.changed.close();
		expect(await idle).toEqual({ value: undefined, done: true });
		const fresh = redis.channels.changed.stream('a');
		const read = fresh.next();
		await Bun.sleep(100);
		await redis.channels.changed.publish({ id: 'a', n: 1 });
		expect((await read).value).toEqual({ id: 'a', n: 1 });
		await fresh.return(undefined);
	});

	test('with the fallback on, an invalid payload still throws INVALID', async () => {
		const redis = await keyedOn();
		const it = redis.channels.resilient.stream('a');
		void it.next();
		await Bun.sleep(100);
		const error = await rejection(
			redis.channels.resilient.publish({ id: 'a' } as never),
		);
		expect(error).toBeInstanceOf(RedisError);
		expect((error as RedisError).code).toBe('INVALID');
		await it.return(undefined);
	});

	test('a stream made before redis.close() and read after it is finished', async () => {
		const redis = await keyedOn();
		const it = redis.channels.changed.stream('a');
		await redis.close();
		expect(await it.next()).toEqual({ value: undefined, done: true });
	});

	describe('on an unreachable server', () => {
		// A subscribe takes ~31 s to fail here; close must not wait for it.
		const unreachable = async () =>
			openRedis(
				defineRedis({
					client: new RedisClient('redis://127.0.0.1:1', {
						enableOfflineQueue: false,
						connectionTimeout: 200,
					}),
					channels: { ...keyed },
				}),
			);

		test('channel.close() does not wait for a subscribe in flight', async () => {
			const redis = await unreachable();
			const it = redis.channels.resilient.stream('a');
			const idle = it.next();
			await Bun.sleep(50);
			const started = performance.now();
			await redis.channels.resilient.close();
			expect(performance.now() - started).toBeLessThan(2000);
			expect(await idle).toEqual({ value: undefined, done: true });
		});

		test('redis.close() does not wait for a subscribe in flight', async () => {
			const redis = await unreachable();
			const it = redis.channels.resilient.stream('a');
			const idle = it.next();
			await Bun.sleep(50);
			const started = performance.now();
			await redis.close();
			expect(performance.now() - started).toBeLessThan(2000);
			expect(await idle).toEqual({ value: undefined, done: true });
		});
	});
});
