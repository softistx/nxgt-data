import { describe, expect, test } from 'bun:test';
import { useRedis } from '../../../../test/fixtures';
import { expectGroupState, grouped, scan } from '../../../../test/group-state';
import { bindQueue } from '../../binding/bind-queue';
import { queueKeys } from '../../keys';
import { cancel } from '../cancel';
import { claim } from '../claim/claim';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const send = (...args: string[]) => client().send(args[0] ?? '', args.slice(1));
const groups = { concurrency: 1 };

/** A delayed job hash written by hand, due now, with `group` as given. */
async function handWritten(id: string, group: string): Promise<void> {
	await client().set(keys.groupsMode, '1:1');
	await send(
		'HSET',
		keys.job(id),
		'data',
		'{"to":"x"}',
		'attempt',
		'0',
		'attempts',
		'3',
		'priority',
		'0',
		'state',
		'delayed',
		'group',
		group,
	);
	await send('ZADD', keys.delayed, '0', id);
}

describe('a stored group the package could not have written', () => {
	test.each([
		['a colon', 'a:b'],
		['a brace', 'a{b}'],
		['769 bytes', 'x'.repeat(769)],
	])('one with %s is refused at claim, and names no key', async (_, group) => {
		await handWritten('a', group);
		const reply = await claim(client(), keys, 1, 30_000, undefined, groups);
		expect(reply.jobs).toEqual([]);
		expect(reply.failedInvalid).toEqual(['a']);
		expect(await client().hget(keys.job('a'), 'state')).toBe('failed');
		expect(await scan(client(), `${keys.group}*`)).toEqual([]);
		await expectGroupState(client(), keys, 1);
	});

	test('a cancel of a waiting one writes no key under its name', async () => {
		await handWritten('a', 'a:b');
		await send('ZREM', keys.delayed, 'a');
		await send('HSET', keys.job('a'), 'state', 'waiting');
		await send('ZADD', keys.ready, '0', 'a');
		await send('ZADD', `${keys.group}:ready`, '0', 'a');
		expect(await cancel(client(), keys, 'a', groups)).toBe(true);
		expect(await scan(client(), `${keys.group}a:b*`)).toEqual([]);
		await expectGroupState(client(), keys, 1);
	});

	test('a group of 256 three-byte characters, as add writes it, is claimed', async () => {
		const group = '€'.repeat(256);
		await bindQueue(client(), grouped(1)).add({ to: 'x' }, { id: 'a', group });
		const reply = await claim(client(), keys, 1, 30_000, undefined, groups);
		expect(reply.jobs.map((job) => job.id)).toEqual(['a']);
		expect(reply.failedInvalid).toEqual([]);
	});
});
