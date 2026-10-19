#!/usr/bin/env bun
/**
 * A local benchmark of `@nxgt/redis`'s queue: `bun run bench:queue`.
 *
 * It never runs in CI nor in `bun run test`: it takes about a minute, and the
 * numbers mean something only on the machine that printed them. It reads the
 * built `dist` (run `bun run build` first), through the public API only.
 *
 * - **Throughput**: 100 000 jobs added with `addMany`, then processed at
 *   concurrency 1, 8 and 64. Adding and processing are timed apart; the
 *   processing clock starts when `work` starts and stops when `idle()`
 *   resolves.
 * - **Latency**: 1 000 sequential jobs on a **parked** worker, each from just
 *   before `add` to the handler's first line. After every sample the worker
 *   is awaited idle and given 10 ms to park on its blocking read again, so
 *   each add pays the wake-up, not a claim the worker was already making.
 *
 * Redis is flushed between scenarios. The worker is closed, then Redis
 * stopped, on exit and on SIGINT. Uses `$REDIS_BIN` like `scripts/redis.ts`.
 */

import { cpus, release } from 'node:os';
import { $, RedisClient } from 'bun';
import { z } from 'zod';
import type { BoundQueue } from '../packages/redis/dist/index';
import { bindQueue, defineQueue } from '../packages/redis/dist/index';
import pkg from '../packages/redis/package.json';
import { startRedis } from '../packages/redis/test/server';
import { percentile, perSecond, renderTable } from './bench-queue-format';

const JOBS = 100_000;
const CHUNK = 5_000;
const SAMPLES = 1_000;
const CONCURRENCIES = [1, 8, 64];

const definition = defineQueue({
	name: 'bench',
	schema: z.object({ n: z.number() }),
	keepCompleted: false,
});

type Queue = BoundQueue<typeof definition.schema, undefined>;
type Worker = ReturnType<Queue['work']>;

let worker: Worker | undefined;
let stopRedis: (() => Promise<void>) | undefined;
let queueClient: RedisClient | undefined;

/** Closes the worker, then stops Redis. Safe to call twice. */
async function shutdown(): Promise<void> {
	const w = worker;
	const stop = stopRedis;
	worker = undefined;
	stopRedis = undefined;
	const own = queueClient;
	queueClient = undefined;
	await w?.close().catch(() => undefined);
	own?.close();
	await stop?.();
}

interface Throughput {
	concurrency: number;
	addPerSecond: number;
	processPerSecond: number;
	processMs: number;
}

/** Adds `JOBS` jobs in chunks, then times how long a worker takes to drain them. */
async function throughput(
	queue: Queue,
	concurrency: number,
): Promise<Throughput> {
	const addStart = performance.now();
	for (let at = 0; at < JOBS; at += CHUNK) {
		await queue.addMany(
			Array.from({ length: CHUNK }, (_, i) => ({ data: { n: at + i } })),
		);
	}
	const addMs = performance.now() - addStart;

	let done = 0;
	const start = performance.now();
	worker = queue.work(
		async () => {
			done++;
		},
		{ concurrency },
	);
	await worker.idle();
	const processMs = performance.now() - start;
	await worker.close();
	worker = undefined;
	if (done !== JOBS) throw new Error(`processed ${done} of ${JOBS} jobs`);
	return {
		concurrency,
		addPerSecond: perSecond(JOBS, addMs),
		processPerSecond: perSecond(JOBS, processMs),
		processMs,
	};
}

/** `SAMPLES` sequential adds on an idle worker, timed to the handler's first line. */
async function latency(queue: Queue): Promise<number[]> {
	let started: (at: number) => void = () => undefined;
	worker = queue.work(
		async () => {
			started(performance.now());
		},
		{ concurrency: 1 },
	);
	await worker.idle();
	await Bun.sleep(200); // let the worker park on its blocking read
	const samples: number[] = [];
	for (let i = 0; i < SAMPLES; i++) {
		const first = new Promise<number>((resolve) => {
			started = resolve;
		});
		const before = performance.now();
		await queue.add({ n: i });
		samples.push((await first) - before);
		await worker.idle();
		await Bun.sleep(10); // park on the blocking read again
	}
	await worker.close();
	worker = undefined;
	return samples;
}

/**
 * The package's version, or `unreleased, after <version> (<sha>)` when
 * `src` differs from the release's tag: the numbers then belong to code
 * that no published version has.
 */
async function packageVersion(): Promise<string> {
	const tag = `@nxgt/redis@${pkg.version}`;
	const dir = new URL('../packages/redis/src', import.meta.url).pathname;
	const same = (await $`git diff --quiet ${tag} -- ${dir}`.nothrow()).exitCode;
	if (same === 0) return pkg.version;
	const sha = (await $`git rev-parse --short HEAD`.nothrow().text()).trim();
	return `unreleased, after ${pkg.version} (${sha || 'no git'})`;
}

/** The machine and versions that frame the numbers. */
async function environment(client: RedisClient): Promise<string> {
	const info = String(await client.send('INFO', ['server']));
	const redisVersion = /redis_version:(\S+)/.exec(info)?.[1] ?? 'unknown';
	const cpu = cpus();
	return renderTable(
		['Machine', 'OS', 'Bun', 'Redis', '@nxgt/redis'],
		[
			[
				`${cpu[0]?.model.trim() ?? 'unknown'}, ${cpu.length} cores`,
				`${process.platform} ${release()}`,
				Bun.version,
				redisVersion,
				await packageVersion(),
			],
		],
	);
}

/** Runs every scenario and prints the tables. */
async function main(): Promise<void> {
	const redis = await startRedis();
	stopRedis = redis.stop;
	queueClient = new RedisClient(redis.uri);
	const queue = bindQueue(queueClient, definition);

	const rows: Throughput[] = [];
	for (const concurrency of CONCURRENCIES) {
		await redis.reset();
		const row = await throughput(queue, concurrency);
		console.error(`concurrency ${concurrency}: ${row.processMs.toFixed(0)} ms`);
		rows.push(row);
	}
	await redis.reset();
	const samples = await latency(queue);

	console.log('# `@nxgt/redis` queue benchmark\n');
	console.log(`${await environment(redis.client)}\n`);
	console.log(`## Throughput, ${JOBS} jobs\n`);
	console.log(
		renderTable(
			['Concurrency', 'add (addMany) jobs/s', 'process jobs/s'],
			rows.map((r) => [
				String(r.concurrency),
				String(r.addPerSecond),
				String(r.processPerSecond),
			]),
		),
	);
	console.log(
		`\n## Latency, add to handler start, parked worker, ${SAMPLES} samples\n`,
	);
	console.log(
		renderTable(
			['p50 ms', 'p99 ms'],
			[
				[
					percentile(samples, 0.5).toFixed(2),
					percentile(samples, 0.99).toFixed(2),
				],
			],
		),
	);
}

if (import.meta.main) {
	process.on('SIGINT', () => {
		void shutdown().finally(() => process.exit(130));
	});
	try {
		await main();
	} finally {
		await shutdown();
	}
}
