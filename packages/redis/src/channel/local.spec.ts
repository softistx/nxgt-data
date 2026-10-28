import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { rejection } from '../../test/rejection';
import * as plain from '../../test/wiring/channels';
import * as keyed from '../../test/wiring/keyed-channels';
import { RedisError } from '../errors/redis-error';
import { defineChannel } from './define-channel';
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
			['changed', 'created', 'deleted', 'fireAndForget', 'resilient'].sort(),
		);
	});

	test('a channel close() resets its hub: a later stream() works afresh', async () => {
		const local = localChannels({ channels });
		const first = local.channels.changed.stream('a');
		const ended = first.next();
		await local.channels.changed.close();
		expect((await ended).done).toBe(true);
		const second = local.channels.changed.stream('a');
		const next = second.next();
		await local.channels.changed.publish({ id: 'a', n: 3 });
		expect((await next).value).toEqual({ id: 'a', n: 3 });
		await second.return(undefined);
		await local.close();
	});

	test('a stream opened after close() ends at once', async () => {
		const local = localChannels({ channels });
		await local.close();
		const late = local.channels.changed.stream('a');
		expect((await late.next()).done).toBe(true);
	});

	test('subscribe after close() is a CONNECTION RedisError', async () => {
		const local = localChannels({ channels });
		await local.close();
		const error = await rejection(local.channels.created.subscribe(() => {}));
		expect((error as RedisError).code).toBe('CONNECTION');
	});

	test('a fallback: local channel streams the same', async () => {
		const local = localChannels({ channels });
		const hears = local.channels.resilient.stream('a');
		const next = hears.next();
		expect(await local.channels.resilient.publish({ id: 'a', n: 1 })).toBe(1);
		expect((await next).value).toEqual({ id: 'a', n: 1 });
		await hears.return(undefined);
		await local.close();
	});

	test('a delivery the schema refuses goes to onError', async () => {
		// The parsed output (a number) no longer matches the input schema once
		// serialised and parsed again, as a subscriber of Redis would see it.
		const lossy = defineChannel({
			name: 'lossy',
			schema: z.string().transform(Number),
		});
		const local = localChannels({ channels: { lossy } });
		const errors: unknown[] = [];
		const seen: unknown[] = [];
		await local.channels.lossy.subscribe((m) => void seen.push(m), {
			onError: (error) => void errors.push(error),
		});
		await local.channels.lossy.publish('1' as never);
		await Promise.resolve();
		await Promise.resolve();
		await local.close();
		expect(seen).toEqual([]);
		expect((errors[0] as RedisError).code).toBe('INVALID');
	});

	test('an onError that throws is logged, not thrown', async () => {
		const local = localChannels({ channels });
		const logged: unknown[][] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => void logged.push(args);
		try {
			await local.channels.created.subscribe(
				() => {
					throw new Error('boom');
				},
				{
					onError: () => {
						throw new Error('onError failed too');
					},
				},
			);
			await local.channels.created.publish(ada);
			await Promise.resolve();
			await Promise.resolve();
		} finally {
			console.error = original;
		}
		expect(String(logged[0]?.[0])).toContain('onError threw');
		await local.close();
	});

	test('a subscription is AsyncDisposable', async () => {
		const local = localChannels({ channels });
		const seen: unknown[] = [];
		{
			await using _running = await local.channels.created.subscribe((p) => {
				seen.push(p);
			});
		}
		expect(await local.channels.created.publish(ada)).toBe(0);
		expect(seen).toEqual([]);
	});

	test('publish counts every subscription it reached', async () => {
		const local = localChannels({ channels });
		await local.channels.created.subscribe(() => {});
		await local.channels.created.subscribe(() => {});
		expect(await local.channels.created.publish(ada)).toBe(2);
		await local.close();
	});

	test('bufferSize drops the oldest unread messages', async () => {
		const local = localChannels({ channels });
		const hears = local.channels.changed.stream('a', { bufferSize: 2 });
		const first = hears.next();
		for (let n = 1; n <= 4; n += 1) {
			await local.channels.changed.publish({ id: 'a', n });
		}
		expect((await first).value).toEqual({ id: 'a', n: 1 });
		expect((await hears.next()).value).toEqual({ id: 'a', n: 3 });
		expect((await hears.next()).value).toEqual({ id: 'a', n: 4 });
		await hears.return(undefined);
		await local.close();
	});
});
