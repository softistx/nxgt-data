import { describe, expect, test } from 'bun:test';
import { connectRedis } from '@nxgt/redis';
import * as caches from '../../test/caches';
import * as channels from '../../test/channels';
import { eventually, useRedis } from '../../test/fixtures';
import { defineConfig } from '../config/define-config';
import { connectKit } from './connect-kit';

const { servers, track } = useRedis();

const kitOn = async (prefix?: string) =>
	track(
		await connectKit(
			defineConfig({ uri: servers.redis.uri, prefix, caches, channels }),
		),
	);

const ada = { id: 'ada', email: 'ada@example.com', seats: 1 };

describe('a channel of the kit', () => {
	test('carries a payload from publish to subscribe', async () => {
		const kit = await kitOn();
		const seen: unknown[] = [];
		await kit.channels.created.subscribe((payload) => {
			seen.push(payload);
		});
		await kit.channels.created.publish(ada);
		await eventually(() => seen.length, 1);
		expect(seen[0]).toEqual(ada);
	});

	test('publishes under the prefixed name, and a plain subscriber sees it there', async () => {
		const kit = await kitOn('myapp:prod');
		const seen: unknown[] = [];
		// Subscribed through the raw client, on the name the prefix produces:
		// proof that the prefix is what actually reaches Redis, not a label.
		const listener = await servers.redis.client.duplicate();
		await listener.connect();
		await listener.subscribe('myapp:prod:user.created', (message: string) => {
			seen.push(JSON.parse(message));
		});
		await kit.channels.created.publish(ada);
		await eventually(() => seen.length, 1);
		expect(seen[0]).toEqual(ada);
		listener.close();
	});

	test('two channels do not hear each other', async () => {
		const kit = await kitOn();
		const created: unknown[] = [];
		const deleted: unknown[] = [];
		await kit.channels.created.subscribe((p) => {
			created.push(p);
		});
		await kit.channels.deleted.subscribe((p) => {
			deleted.push(p);
		});
		await kit.channels.deleted.publish({ id: 'ada' });
		await eventually(() => deleted.length, 1);
		expect(created).toEqual([]);
	});

	test('a payload the schema refuses is a RedisError, from the package itself', async () => {
		const kit = await kitOn();
		const error = await kit.channels.deleted.publish({ id: 42 } as never).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect((error as Error).name).toBe('RedisError');
		expect((error as { code: string }).code).toBe('INVALID');
	});
});

describe('the subscriptions the kit keeps', () => {
	test('close() closes the ones nobody closed', async () => {
		const kit = await kitOn();
		const seen: unknown[] = [];
		await kit.channels.created.subscribe((p) => {
			seen.push(p);
		});
		await kit.channels.created.publish(ada);
		await eventually(() => seen.length, 1);

		await kit.close();

		// The kit is gone; a message published on the same name through the
		// raw client reaches nothing it left behind.
		await servers.redis.client.publish(
			'user.created',
			JSON.stringify({ ...ada, id: 'grace' }),
		);
		await Bun.sleep(100);
		expect(seen).toHaveLength(1);
	});

	test('a subscription closed early is not closed twice by the kit', async () => {
		const kit = await kitOn();
		const subscription = await kit.channels.created.subscribe(() => {});
		await subscription.close();
		// The kit forgot it when it was closed, so `close()` has nothing left
		// to do for it — and would be safe either way, since `@nxgt/redis`
		// memoises its own close.
		await kit.close();
		await expect(subscription.close()).resolves.toBeUndefined();
	});

	test('a subscription disposed with await using is forgotten too', async () => {
		const kit = await kitOn();
		const seen: unknown[] = [];
		{
			await using running = await kit.channels.created.subscribe((p) => {
				seen.push(p);
			});
			void running;
			await kit.channels.created.publish(ada);
			await eventually(() => seen.length, 1);
		}
		// Disposed at the end of the block, so the kit is no longer holding
		// it — and what it publishes next reaches nothing.
		await kit.channels.created.publish(ada);
		await Bun.sleep(100);
		expect(seen).toHaveLength(1);
		await kit.close();
	});

	test('close() takes the subscriptions but leaves a handed-in client open', async () => {
		// The two rules meet here: what the kit started it closes, and what it
		// did not open it keeps its hands off.
		const held = await connectRedis(servers.redis.uri);
		const kit = await connectKit(
			defineConfig({ client: held.client, caches, channels }),
		);
		const seen: unknown[] = [];
		await kit.channels.created.subscribe((p) => {
			seen.push(p);
		});
		await kit.channels.created.publish(ada);
		await eventually(() => seen.length, 1);

		await kit.close();

		await held.client.publish('user.created', JSON.stringify(ada));
		await Bun.sleep(100);
		expect(seen).toHaveLength(1);
		// Still usable: the kit closed its subscription, not the client.
		await held.client.set('still', 'here');
		expect(await held.client.get('still')).toBe('here');
		await held.close();
	});

	test('close() is idempotent', async () => {
		const kit = await kitOn();
		await kit.channels.created.subscribe(() => {});
		await kit.close();
		await expect(kit.close()).resolves.toBeUndefined();
	});

	test('await using closes the kit at the end of the block', async () => {
		const seen: unknown[] = [];
		{
			await using kit = await kitOn();
			await kit.channels.created.subscribe((p) => {
				seen.push(p);
			});
			await kit.channels.created.publish(ada);
			await eventually(() => seen.length, 1);
		}
		await servers.redis.client.publish('user.created', JSON.stringify(ada));
		await Bun.sleep(100);
		expect(seen).toHaveLength(1);
	});

	test('a handler that throws goes to onError, not past the subscription', async () => {
		const kit = await kitOn();
		const errors: unknown[] = [];
		await kit.channels.created.subscribe(
			() => {
				throw new Error('the handler broke');
			},
			{ onError: (error) => errors.push(error) },
		);
		await kit.channels.created.publish(ada);
		await eventually(() => errors.length, 1);
		expect((errors[0] as Error).message).toBe('the handler broke');
	});
});
