import { expect, test } from 'bun:test';
import { useRedis } from '../../../../test/fixtures';
import {
	addGrouped,
	grouped,
	groupViolations,
} from '../../../../test/group-state';
import { scheduleCalls } from '../../../../test/schedule-calls';
import { QueueError } from '../../../errors/queue-error';
import { runScript } from '../../../scripts/run-script';
import { bindQueue } from '../../binding/bind-queue';
import { queueKeys } from '../../binding/keys';
import { ADD } from '../add';
import { claim, groupArgs } from '../claim/claim';
import { complete, fail } from '../settle';

/*
 * A seeded mix of every transition on a grouped queue, the four invariants
 * checked after each step. The seed is fixed so a failure replays; `FUZZ_SEED`
 * overrides it for a one-off run with another, and the operations done so far
 * are in the failure's message.
 */

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const CAP = 2;
const GROUPS = ['A', 'B', 'C', ''];
const SEED = Number(process.env['FUZZ_SEED'] ?? 42);
const STEPS = 300;

/** A small deterministic generator: the same seed gives the same numbers. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

test(`seed ${SEED}: ${STEPS} operations keep the group invariants`, async () => {
	const random = mulberry32(SEED);
	const below = (n: number) => Math.floor(random() * n);
	const pick = <T>(items: readonly T[]): T | undefined =>
		items[below(items.length)];
	const q = bindQueue(client(), grouped(CAP));
	const calls = scheduleCalls(client);
	const known: string[] = [];
	const tokens = new Map<string, string>();
	const log: string[] = [];
	let counter = 0;
	let schedules = 0;
	const fresh = () => {
		counter += 1;
		return `j${counter}`;
	};
	const debounce = (id: string, group: string, dkey: string) =>
		runScript(
			client(),
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
			[
				keys.prefix,
				keys.dedupe,
				...groupArgs(keys, { concurrency: CAP }),
				id,
				'{"to":"x"}',
				below(3),
				below(2) + 1,
				below(3) === 0 ? 5 : 0,
				-1,
				-1,
				'd',
				dkey,
				60_000,
				group,
			],
		);
	const tolerated = async (run: () => Promise<unknown>) => {
		try {
			await run();
		} catch (error) {
			if (!(error instanceof QueueError)) throw error;
		}
	};

	const step = async (): Promise<string> => {
		const roll = below(100);
		const id = pick(known) ?? 'none';
		if (roll < 20) {
			const group = pick(GROUPS) ?? '';
			const jobId = fresh();
			known.push(jobId);
			await addGrouped(client(), keys, CAP, [
				{ id: jobId, group, priority: below(3), attempts: below(2) + 1 },
			]);
			return `add ${jobId} group "${group}"`;
		}
		if (roll < 30) {
			const n = below(2) + 1;
			const reply = await claim(client(), keys, n, 30_000, undefined, {
				concurrency: CAP,
			});
			for (const job of reply.jobs) tokens.set(job.id, job.token);
			return `claim ${n} -> ${reply.jobs.map((j) => j.id).join(',')}`;
		}
		if (roll < 40) {
			const active = (await client().send('ZRANGE', [
				keys.active,
				'0',
				'-1',
			])) as string[];
			const target = pick(active) ?? id;
			await complete(
				client(),
				keys,
				grouped(CAP),
				target,
				tokens.get(target) ?? 'x',
				undefined,
				below(2) === 0,
			);
			return `complete ${target}`;
		}
		if (roll < 50) {
			const active = (await client().send('ZRANGE', [
				keys.active,
				'0',
				'-1',
			])) as string[];
			const target = pick(active) ?? id;
			const retryIn = below(2) === 0 ? null : 0;
			await fail(
				client(),
				keys,
				grouped(CAP),
				target,
				tokens.get(target) ?? 'x',
				{ name: 'x', message: 'boom' },
				retryIn,
				below(2) === 0,
			);
			return `fail ${target} retryIn ${retryIn}`;
		}
		if (roll < 60) {
			const short = await claim(client(), keys, below(2) + 1, 1, undefined, {
				concurrency: CAP,
			});
			for (const job of short.jobs) tokens.set(job.id, job.token);
			await Bun.sleep(4);
			const again = await claim(client(), keys, 1, 30_000, undefined, {
				concurrency: CAP,
			});
			for (const job of again.jobs) tokens.set(job.id, job.token);
			return `lapse ${short.jobs.map((j) => j.id).join(',')} -> stalled ${again.stalled.join(',')}`;
		}
		if (roll < 70) {
			await tolerated(() => q.cancel(id));
			return `cancel ${id}`;
		}
		if (roll < 75) {
			await tolerated(() => q.remove(id));
			return `remove ${id}`;
		}
		if (roll < 80) {
			await tolerated(() => q.retry(id));
			return `retry ${id}`;
		}
		if (roll < 85) {
			const jobId = fresh();
			const group = pick(GROUPS) ?? '';
			const dkey = `k${below(3)}`;
			known.push(jobId);
			await debounce(jobId, group, dkey);
			return `debounce ${jobId} group "${group}" key ${dkey}`;
		}
		if (roll < 90) {
			const items = Array.from({ length: below(2) + 2 }, () => {
				const jobId = fresh();
				known.push(jobId);
				return { jobId, group: pick(GROUPS) ?? '' };
			});
			await q.addMany(
				items.map((item) => ({
					data: { to: 'x' },
					options: {
						id: item.jobId,
						...(item.group === '' ? {} : { group: item.group }),
						priority: below(3),
					},
				})),
			);
			return `addMany ${items.map((i) => `${i.jobId}:"${i.group}"`).join(',')}`;
		}
		if (roll < 94) {
			await q.pause();
			return 'pause';
		}
		if (roll < 98) {
			await q.resume();
			return 'resume';
		}
		schedules += 1;
		const scheduleId = `s${schedules}`;
		await calls.upsert(scheduleId, 1000);
		await calls.fire(scheduleId, 1000, 2000, -1, { concurrency: CAP });
		known.push(`schedule:${scheduleId}:1000`);
		return `fire ${scheduleId}`;
	};

	for (let i = 1; i <= STEPS; i += 1) {
		let done = '';
		try {
			done = await step();
			log.push(`${i}: ${done}`);
			const bad = await groupViolations(client(), keys, CAP);
			if (bad.length > 0)
				throw new Error(`group invariants: ${bad.join('; ')}`);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(
				`seed ${SEED} failed at step ${i} (${done}): ${reason}\n${log.join('\n')}`,
			);
		}
	}
	expect(log).toHaveLength(STEPS);
}, 60_000);
