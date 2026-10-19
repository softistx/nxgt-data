import type { RedisClient } from 'bun';
import type { queueKeys } from '../src/queue/binding/keys';
import { ADD } from '../src/queue/scripts/add';
import { groupArgs } from '../src/queue/scripts/claim/claim';
import { runScript } from '../src/scripts/run-script';
import { mailQueue } from './fixtures';

type Keys = ReturnType<typeof queueKeys>;

/** A queue definition with groups, built by hand: `concurrency` 0 means no cap. */
export const grouped = (concurrency: number) => ({
	...mailQueue,
	groups: { concurrency },
});

/** One job for {@link addGrouped}: `group` `''` is the default group. */
export type GroupedJob = {
	id: string;
	group: string;
	priority?: number;
	attempts?: number;
};

/**
 * Adds jobs to a grouped queue by calling `ADD` as the client will, one
 * script for all of them, due now and without a dedupe key.
 */
export async function addGrouped(
	client: RedisClient,
	keys: Keys,
	concurrency: number,
	jobs: readonly GroupedJob[],
): Promise<void> {
	const argv: (string | number)[] = [
		keys.prefix,
		keys.dedupe,
		...groupArgs(keys, { concurrency }),
	];
	for (const job of jobs) {
		argv.push(
			job.id,
			'{"to":"x"}',
			job.priority ?? 0,
			job.attempts ?? 3,
			0,
			-1,
			-1,
			'',
			'',
			0,
			job.group,
		);
	}
	await runScript(
		client,
		ADD,
		[
			keys.delayed,
			keys.ready,
			keys.seq,
			keys.wake,
			keys.paused,
			keys.groupsReady,
			keys.groupsQueued,
			keys.groupsMode,
		],
		argv,
	);
}

/** Every key of `client`'s server matching `pattern`, by SCAN. */
export async function scan(
	client: RedisClient,
	pattern: string,
): Promise<string[]> {
	const found: string[] = [];
	let cursor = '0';
	do {
		const [next, batch] = (await client.send('SCAN', [
			cursor,
			'MATCH',
			pattern,
			'COUNT',
			'100',
		])) as [string, string[]];
		found.push(...batch);
		cursor = String(next);
	} while (cursor !== '0');
	return found;
}

const members = async (client: RedisClient, key: string) =>
	(await client.send('ZRANGE', [key, '0', '-1'])) as string[];

/**
 * The invariants of a grouped queue (see `GROUP_FN`), read from the server:
 * what is wrong, one line each, or an empty list. Every group spec ends with
 * {@link expectGroupState}.
 */
export async function groupViolations(
	client: RedisClient,
	keys: Keys,
	concurrency: number,
): Promise<string[]> {
	const bad: string[] = [];
	const ready = await members(client, keys.ready);
	const activeIds = await members(client, keys.active);
	const mirror = new Map<string, string[]>();
	for (const key of await scan(client, `${keys.group}*:ready`)) {
		const g = key.slice(keys.group.length, -':ready'.length);
		mirror.set(g, await members(client, key));
	}
	const groupOf = async (id: string) =>
		(await client.hget(keys.job(id), 'group')) ?? '';
	// 1: ready and its mirror hold the same ids, each in its own group.
	const mirrored = new Set<string>();
	for (const [g, ids] of mirror) {
		for (const id of ids) {
			mirrored.add(id);
			if (!ready.includes(id))
				bad.push(`1: ${id} in group "${g}" not in ready`);
			if ((await groupOf(id)) !== g)
				bad.push(`1: ${id} is in the zset of "${g}"`);
		}
	}
	for (const id of ready) {
		if (!mirrored.has(id)) bad.push(`1: ${id} in ready, in no group zset`);
	}
	// 2: the counter of a named group is its number of active ids.
	const counted = new Map<string, number>();
	for (const id of activeIds) {
		const g = await groupOf(id);
		if (g !== '') counted.set(g, (counted.get(g) ?? 0) + 1);
	}
	const counters = new Map<string, number>();
	for (const key of await scan(client, `${keys.group}*:active`)) {
		const g = key.slice(keys.group.length, -':active'.length);
		counters.set(g, Number(await client.get(key)));
	}
	for (const g of new Set([...counted.keys(), ...counters.keys()])) {
		if ((counted.get(g) ?? 0) !== (counters.get(g) ?? 0)) {
			bad.push(
				`2: "${g}" has ${counted.get(g) ?? 0} active, counter ${counters.get(g) ?? 0}`,
			);
		}
	}
	if (counters.has('')) bad.push('2: the default group has a counter');
	// 3: the list and the set are the same groups, once each.
	const list = (await client.send('LRANGE', [
		keys.groupsReady,
		'0',
		'-1',
	])) as string[];
	const set = (await client.send('SMEMBERS', [keys.groupsQueued])) as string[];
	if (new Set(list).size !== list.length)
		bad.push('3: a group is listed twice');
	if ([...list].sort().join('|') !== [...set].sort().join('|')) {
		bad.push(
			`3: list ${JSON.stringify(list)} is not set ${JSON.stringify(set)}`,
		);
	}
	// 4: a group with ready jobs and a free slot is queued.
	for (const [g, ids] of mirror) {
		const free =
			g === '' || concurrency === 0 || (counters.get(g) ?? 0) < concurrency;
		if (ids.length > 0 && free && !set.includes(g))
			bad.push(`4: "${g}" is claimable, not queued`);
	}
	return bad;
}

/** Throws with the violations when the queue's group state is not sound. */
export async function expectGroupState(
	client: RedisClient,
	keys: Keys,
	concurrency: number,
): Promise<void> {
	const bad = await groupViolations(client, keys, concurrency);
	if (bad.length > 0) throw new Error(`group invariants: ${bad.join('; ')}`);
}
