import { describe, expect, test } from 'bun:test';
import { rejection } from '../../test/rejection';
import * as plain from '../../test/wiring/channels';
import * as keyed from '../../test/wiring/keyed-channels';
import { RedisError } from '../errors/redis-error';
import { localChannels } from './local';

const channels = { ...plain, ...keyed };
const ada = { id: 'ada', email: 'ada@example.com', seats: 1 };

describe('local channels', () => {
	test('publish reaches a subscriber, parsed, with no client', async () => {
		const local = localChannels({ channels });
		const seen: unknown[] = [];
		await local.channels.created.subscribe((payload) => {
			seen.push(payload);
		});
		const reached = await local.channels.created.publish(ada);
		await Promise.resolve();
		expect(reached).toBe(1);
		expect(seen).toEqual([ada]);
		await local.close();
	});

	test('two channels do not hear each other', async () => {
		const local = localChannels({ channels });
		const seen: unknown[] = [];
		await local.channels.created.subscribe((payload) => {
			seen.push(payload);
		});
		expect(await local.channels.deleted.publish({ id: 'ada' })).toBe(0);
		expect(seen).toEqual([]);
		await local.close();
	});

	test('publish with no subscriber resolves with 0', async () => {
		const local = localChannels({ channels });
		expect(await local.channels.changed.publish({ id: 'a', n: 1 })).toBe(0);
	});

	test('a payload the schema refuses is an INVALID RedisError', async () => {
		const local = localChannels({ channels });
		const held = rejection(local.channels.deleted.publish({ id: 42 } as never));
		const error = await held;
		expect(error).toBeInstanceOf(RedisError);
		expect((error as RedisError).code).toBe('INVALID');
		expect((error as RedisError).key).toBe('user.deleted');
	});

	test('stream(key) hears its key only, in order', async () => {
		const local = localChannels({ channels });
		const hears = local.channels.changed.stream('a');
		const next = hears.next();
		await local.channels.changed.publish({ id: 'b', n: 0 });
		await local.channels.changed.publish({ id: 'a', n: 1 });
		await local.channels.changed.publish({ id: 'a', n: 2 });
		expect((await next).value).toEqual({ id: 'a', n: 1 });
		expect((await hears.next()).value).toEqual({ id: 'a', n: 2 });
		await hears.return(undefined);
		await local.close();
	});

	test('a stream hears a message after the schema transforms it', async () => {
		const local = localChannels({ channels });
		const hears = local.channels.changed.stream('a');
		const next = hears.next();
		await local.channels.changed.publish({ id: 'a', n: 1, extra: 1 } as never);
		expect((await next).value).toEqual({ id: 'a', n: 1 });
		await hears.return(undefined);
	});

	test('stream on a channel with no key is a TypeError', () => {
		const local = localChannels({ channels });
		expect(() => local.channels.created.stream('x')).toThrow(
			'stream() needs a `key`',
		);
	});

	test('close() ends open streams and subscriptions', async () => {
		const local = localChannels({ channels });
		const hears = local.channels.changed.stream('a');
		const next = hears.next();
		await local.channels.created.subscribe(() => {});
		await local.close();
		expect((await next).done).toBe(true);
		expect(await local.channels.created.publish(ada)).toBe(0);
		await local.close();
	});

	test('a closed subscription is not called again', async () => {
		const local = localChannels({ channels });
		const seen: unknown[] = [];
		const subscription = await local.channels.created.subscribe((p) => {
			seen.push(p);
		});
		await subscription.close();
		expect(await local.channels.created.publish(ada)).toBe(0);
		expect(seen).toEqual([]);
	});

	test('a handler that throws goes to onError, not out of publish', async () => {
		const local = localChannels({ channels });
		const errors: unknown[] = [];
		await local.channels.created.subscribe(
			() => {
				throw new Error('boom');
			},
			{ onError: (error) => errors.push(error) },
		);
		await local.channels.created.publish(ada);
		await Promise.resolve();
		await Promise.resolve();
		expect((errors[0] as Error).message).toBe('boom');
		await local.close();
	});

	test('keeps only the channels of the object it is given', () => {
		const local = localChannels({
			channels: { ...channels, note: 'not a channel' },
		});
		expect(Object.keys(local.channels).sort()).toEqual(
			['changed', 'created', 'deleted', 'resilient'].sort(),
		);
	});
});
