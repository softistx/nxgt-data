import { describe, expect, test } from 'bun:test';
import { eventually, useRedis, userCreated } from '../../test/fixtures';
import { RedisError } from '../errors/redis-error';
import { publish, subscribe } from './pubsub';

const servers = useRedis();
const ada = { id: 'u1', email: 'ada@example.com', seats: 1 };

describe('pub/sub', () => {
	test('a subscriber gets what was published, parsed by the schema', async () => {
		const seen: unknown[] = [];
		await using running = await subscribe(
			servers.redis.client,
			userCreated,
			(user) => {
				seen.push(user);
			},
		);
		expect(running.channel).toBe('user.created');

		await publish(servers.redis.client, userCreated, ada);
		await eventually(() => seen, [ada]);
	});

	test('the client that publishes is not the one that listens', async () => {
		// A subscriber connection can run no other command, so `subscribe`
		// duplicates. Were it holding the caller's client, this would fail.
		await using running = await subscribe(
			servers.redis.client,
			userCreated,
			() => undefined,
		);
		expect(running.channel).toBe('user.created');
		await servers.redis.client.set('still', 'usable');
		expect(await servers.redis.client.get('still')).toBe('usable');
	});

	test('publish gives the number of subscribers Redis handed it to', async () => {
		expect(await publish(servers.redis.client, userCreated, ada)).toBe(0);
		await using _running = await subscribe(
			servers.redis.client,
			userCreated,
			() => undefined,
		);
		await eventually(() => publish(servers.redis.client, userCreated, ada), 1);
	});

	test('refuses a message the schema does not accept', async () => {
		const wrong = { id: 'u1' } as unknown as typeof ada;
		await expect(
			publish(servers.redis.client, userCreated, wrong),
		).rejects.toThrow(RedisError);
	});

	test('a message that does not match reaches onError, not the handler', async () => {
		const handled: unknown[] = [];
		const errors: unknown[] = [];
		await using _running = await subscribe(
			servers.redis.client,
			userCreated,
			(user) => {
				handled.push(user);
			},
			{ onError: (error) => errors.push(error) },
		);
		// Published raw, so it bypasses `publish`'s own check — what another
		// service, or an older deploy, would put on the channel.
		await eventually(
			() => servers.redis.client.publish('user.created', '{"id":"u1"}'),
			1,
		);
		await eventually(() => errors.length, 1);
		expect((errors[0] as RedisError).code).toBe('INVALID');
		expect(handled).toEqual([]);
	});

	test('a handler that throws reaches onError, and does not end the process', async () => {
		const errors: unknown[] = [];
		await using _running = await subscribe(
			servers.redis.client,
			userCreated,
			() => {
				throw new Error('handler failed');
			},
			{ onError: (error) => errors.push(error) },
		);
		await eventually(() => publish(servers.redis.client, userCreated, ada), 1);
		await eventually(() => errors.length, 1);
		expect((errors[0] as Error).message).toBe('handler failed');
	});

	test('an onError that throws is caught too, and the subscription lives on', async () => {
		// The last resort must not be able to throw: were it not guarded, this
		// rejection would have nobody holding it, and in a real process Bun
		// ends on that. Here it would fail the run; either way it is measured.
		const handled: unknown[] = [];
		let thrown = 0;
		await using _running = await subscribe(
			servers.redis.client,
			userCreated,
			(user) => {
				handled.push(user);
			},
			{
				onError: () => {
					thrown += 1;
					throw new Error('onError failed too');
				},
			},
		);
		await eventually(
			() => servers.redis.client.publish('user.created', '{"id":"u1"}'),
			1,
		);
		await eventually(() => thrown, 1);
		// The subscription is still listening after its own last resort threw.
		await eventually(() => publish(servers.redis.client, userCreated, ada), 1);
		await eventually(() => handled, [ada]);
	});

	test('closing stops the messages, and closing twice is closing once', async () => {
		const seen: unknown[] = [];
		const running = await subscribe(servers.redis.client, userCreated, (u) => {
			seen.push(u);
		});
		await eventually(() => publish(servers.redis.client, userCreated, ada), 1);
		await eventually(() => seen.length, 1);

		await running.close();
		await running.close();

		expect(await publish(servers.redis.client, userCreated, ada)).toBe(0);
		await Bun.sleep(100);
		expect(seen).toHaveLength(1);
	});
});
