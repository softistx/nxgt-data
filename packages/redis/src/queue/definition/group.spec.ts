import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { scriptCalls, useRedis } from '../../../test/fixtures';
import { rejection } from '../../../test/rejection';
import { bindQueue } from '../binding/bind-queue';
import { queueKeys } from '../binding/keys';
import { defineQueue } from './define-queue';

const servers = useRedis();
const schema = z.object({ n: z.number() });
const plain = defineQueue({ name: 'plain', schema });
const fair = defineQueue({ name: 'fair', schema, groups: {} });
const capped = defineQueue({
	name: 'capped',
	schema,
	groups: { concurrency: 2 },
});

describe('the groups option', () => {
	test('is stored as 0 for fairness only, and frozen', () => {
		expect(plain.groups).toBeUndefined();
		expect(fair.groups).toEqual({ concurrency: 0 });
		expect(capped.groups).toEqual({ concurrency: 2 });
		expect(Object.isFrozen(fair.groups)).toBe(true);
	});

	test.each([0, 1.5, -1, Number.NaN, '2'])(
		'refuses a concurrency of %p',
		(value) => {
			expect(() =>
				defineQueue({
					name: 'q',
					schema,
					groups: { concurrency: value as never },
				}),
			).toThrow(
				new TypeError(
					'defineQueue: "q" has groups concurrency; it is a whole number of jobs per group, at least 1, or left out for no cap',
				),
			);
		},
	);

	test('refuses groups that is not an object', () => {
		expect(() =>
			defineQueue({ name: 'q', schema, groups: 3 as never }),
		).toThrow(
			new TypeError(
				'defineQueue: "q" has groups that is not an object; it is { concurrency? }',
			),
		);
	});
});

describe('add with a group', () => {
	test('refuses a group on an ungrouped queue, with no round trip', async () => {
		const client = servers.redis.client;
		const before = await scriptCalls(client);
		const queue = bindQueue(client, plain);
		const error = await rejection(queue.add({ n: 1 }, { group: 'a' }));
		expect(error).toEqual(
			new TypeError('add on "plain": group needs groups in defineQueue'),
		);
		const many = await rejection(
			queue.addMany([{ data: { n: 1 }, options: { group: 'a' } }]),
		);
		expect((many as Error).message).toBe(
			'addMany on "plain": group needs groups in defineQueue',
		);
		expect(await scriptCalls(client)).toBe(before);
	});

	test.each(['', 'a:b', 'a{b', 'a}b', 'x'.repeat(257), 1])(
		'refuses the group %p',
		async (group) => {
			const error = await rejection(
				bindQueue(servers.redis.client, fair).add({ n: 1 }, { group } as never),
			);
			expect((error as Error).message).toBe(
				'add on "fair": group is a string of 1 to 256 characters without braces or colons',
			);
		},
	);

	test('shows the group in get, and leaves it out for the default group', async () => {
		const queue = bindQueue(servers.redis.client, capped);
		const a = await queue.add({ n: 1 }, { group: 'tenant-a' });
		const b = await queue.add({ n: 2 });
		expect((await queue.get(a.id))?.group).toBe('tenant-a');
		const view = await queue.get(b.id);
		expect(view).toBeDefined();
		expect('group' in (view ?? {})).toBe(false);
		const client = servers.redis.client;
		expect(
			await client.send('ZRANGE', [
				`${queueKeys('capped').group}tenant-a:ready`,
				'0',
				'-1',
			]),
		).toEqual([a.id]);
	});
});
