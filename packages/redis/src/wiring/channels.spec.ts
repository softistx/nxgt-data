import { describe, expect, test } from 'bun:test';
import { eventually, useRedis } from '../../test/fixtures';
import * as caches from '../../test/wiring/caches';
import * as channels from '../../test/wiring/channels';
import { connectRedis } from '../connection/connect';
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
});
