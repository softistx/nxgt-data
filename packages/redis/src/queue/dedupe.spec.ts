import { describe, expect, test } from 'bun:test';
import { mailQueue, scriptCalls, useRedis } from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { bindQueue } from './bind-queue';
import { queueKeys } from './keys';
import type { AddOptions } from './types';

const servers = useRedis();
const keys = queueKeys('mails');
const mails = () => bindQueue(servers.redis.client, mailQueue);
const send = (...args: string[]) =>
	servers.redis.client.send(args[0] ?? '', args.slice(1));

describe('addMany with debounce and throttle', () => {
	test('addMany debounces in order within one call', async () => {
		const [first, second] = await mails().addMany([
			{ data: { to: 'one' }, options: { debounce: { key: 'k', wait: '1h' } } },
			{ data: { to: 'two' }, options: { debounce: { key: 'k', wait: '1h' } } },
		]);
		expect(first?.deduplicated).toBe(false);
		expect([second?.id, second?.deduplicated]).toEqual([first?.id, true]);
		expect(await send('ZCARD', keys.delayed)).toBe(1);
		const data = await servers.redis.client.hget(
			keys.job(first?.id ?? ''),
			'data',
		);
		expect(JSON.parse(data ?? '').to).toBe('two');
	});

	test('addMany throttles item by item and mixes in plain jobs', async () => {
		const handles = await mails().addMany([
			{ data: { to: 'a' }, options: { throttle: { key: 'k', window: '1h' } } },
			{ data: { to: 'b' } },
			{ data: { to: 'c' }, options: { throttle: { key: 'k', window: '1h' } } },
		]);
		expect(handles.map((handle) => handle.deduplicated)).toEqual([
			false,
			false,
			true,
		]);
		expect(handles[2]?.id).toBe(handles[0]?.id ?? '');
		expect(await send('ZCARD', keys.ready)).toBe(2);
	});

	test('add takes one round trip with a debounce', async () => {
		const client = servers.redis.client;
		const before = await scriptCalls(client);
		await mails().add({ to: 'a' }, { debounce: { key: 'k', wait: '1h' } });
		expect((await scriptCalls(client)) - before).toBe(1);
	});
});

describe('the refusals of debounce and throttle', () => {
	const KEY =
		'a string of 1 to 256 characters without braces, which are a hash tag';
	const cases: [string, unknown, string][] = [
		[
			'debounce with id',
			{ debounce: { key: 'k', wait: 1 }, id: 'x' },
			'debounce and id cannot be combined; the key names the job',
		],
		[
			'debounce with delay',
			{ debounce: { key: 'k', wait: 1 }, delay: 5 },
			'debounce and delay cannot be combined; wait sets the run time',
		],
		[
			'debounce with at',
			{ debounce: { key: 'k', wait: 1 }, at: new Date() },
			'debounce and at cannot be combined; wait sets the run time',
		],
		[
			'debounce with throttle',
			{ debounce: { key: 'k', wait: 1 }, throttle: { key: 'k', window: 1 } },
			'debounce and throttle cannot be combined; give one',
		],
		[
			'throttle with id',
			{ throttle: { key: 'k', window: 1 }, id: 'x' },
			'throttle and id cannot be combined; the key names the job',
		],
		[
			'a debounce key with a brace',
			{ debounce: { key: 'a{b', wait: 1 } },
			`debounce.key is ${KEY}`,
		],
		[
			'an empty throttle key',
			{ throttle: { key: '', window: 1 } },
			`throttle.key is ${KEY}`,
		],
		[
			'a key that is too long',
			{ throttle: { key: 'x'.repeat(257), window: 1 } },
			`throttle.key is ${KEY}`,
		],
		[
			'a key that is not a string',
			{ debounce: { key: 5, wait: 1 } },
			`debounce.key is ${KEY}`,
		],
		[
			'wait 0',
			{ debounce: { key: 'k', wait: 0 } },
			"debounce.wait is at least 1 millisecond, as a whole number or a string such as '10m'",
		],
		[
			'a malformed window',
			{ throttle: { key: 'k', window: '1w' } },
			"throttle.window is at least 1 millisecond, as a whole number or a string such as '10m'",
		],
		[
			'a debounce that is not an object',
			{ debounce: 'k' },
			'debounce is an object { key, wait }',
		],
	];

	for (const [name, options, message] of cases) {
		test(`${name} is a TypeError and no round trip`, async () => {
			const client = servers.redis.client;
			const before = await scriptCalls(client);
			const error = await rejection(
				mails().add({ to: 'a' }, options as AddOptions),
			);
			expect(error).toBeInstanceOf(TypeError);
			expect((error as Error).message).toBe(`add on "mails": ${message}`);
			const many = await rejection(
				mails().addMany([
					{ data: { to: 'a' }, options: options as AddOptions },
				]),
			);
			expect((many as Error).message).toBe(`addMany on "mails": ${message}`);
			expect(await scriptCalls(client)).toBe(before);
		});
	}
});
