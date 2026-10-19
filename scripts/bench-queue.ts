#!/usr/bin/env bun
/**
 * A local benchmark of `@nxgt/redis`'s queue: `bun run bench:queue`.
 *
 * It never runs in CI nor in `bun run test`: it takes minutes, and the
 * numbers mean something only on the machine that printed them. It reads the
 * built `dist` (run `bun run build` first), through the public API only.
 *
 * - **Throughput**: 100 000 jobs added with `addMany`, then processed at
 *   concurrency 1, 8 and 64. Adding and processing are timed apart; the
 *   processing clock starts when `work` starts and stops when `idle()`
 *   resolves.
 * - **Latency**: 1 000 sequential jobs on an idle worker, each from just
 *   before `add` to the handler's first line.
 *
 * Redis is flushed between scenarios. The worker is closed, then Redis
 * stopped, on exit and on SIGINT. Uses `$REDIS_BIN` like `scripts/redis.ts`.
 */

import { cpus, release } from 'node:os';
import { RedisClient } from 'bun';
import type { BoundQueue } from '../packages/redis/dist/index';
import { bindQueue, defineQueue } from '../packages/redis/dist/index';
// The root has no zod of its own: the package's, which the queue itself uses.
import { z } from '../packages/redis/node_modules/zod';
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

/** Closes the worker, then stops Redis. Safe to call twice. */
async function shutdown(): Promise<void> {
	const w = worker;
	const stop = stopRedis;
	worker = undefined;
	stopRedis = undefined;
	await w?.close().catch(() => undefined);
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
	}
	await worker.close();
	worker = undefined;
	return samples;
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
				pkg.version,
			],
		],
	);
}

/** Runs every scenario and prints the tables. */
async function main(): Promise<void> {
	const redis = await startRedis();
	stopRedis = redis.stop;
	const queue = bindQueue(new RedisClient(redis.uri), definition);

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
	console.log(`\n## Latency, add to handler start, ${SAMPLES} samples\n`);
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
