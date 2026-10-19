// A queue an app exports, defined and bound, behind exported values whose
// types are inferred: a declaration build must be able to name each one
// through `@nxgt/redis` and its peers alone (TS2883 otherwise).
import {
	bindQueue,
	defineQueue,
	defineRedis,
	openRedis,
	type RetryOptions,
} from '@nxgt/redis';
import type { RedisClient } from 'bun';
import { z } from 'zod';

/** Bun's client: its types are a Bun consumer's, so the bound queue names it. */
declare const redis: RedisClient;

export const mails = defineQueue({
	name: 'mails',
	schema: z.object({
		to: z.string(),
		template: z.string().default('welcome'),
	}),
	attempts: 5,
	backoff: { base: '2s' },
});

/** A bound queue: its `definition` names the schema's types too. */
export const mailQueue = bindQueue(redis, mails);

export function enqueued() {
	return mailQueue.add({ to: 'ada@example.com' }, { delay: '10m' });
}

/** A debounced and a throttled add: the option types come through the entry. */
export function flowControlled() {
	return [
		mailQueue.add(
			{ to: 'ada@example.com' },
			{ debounce: { key: 'ada', wait: '30s' } },
		),
		mailQueue.add(
			{ to: 'ada@example.com' },
			{ throttle: { key: 'digest', window: '1h' } },
		),
	];
}

export function worker() {
	return mailQueue.work(({ data }) => data.template, { concurrency: 4 });
}

/** A queue with a result schema: `finished` and the handler name its type. */
export const renders = defineQueue({
	name: 'renders',
	schema: z.object({ url: z.string() }),
	result: z.object({ bytes: z.number() }),
	timeout: '1m',
});

export const renderQueue = bindQueue(redis, renders);

export async function rendered() {
	const handle = await renderQueue.add({ url: 'https://example.com' });
	return handle.finished();
}

export function renderWorker() {
	return renderQueue.work(() => ({ bytes: 1 }));
}

/** A handler with a schema'd step and a key: `step` and `key` come through `JobContext`'s exported type. */
export function steppedWorker() {
	return mailQueue.work(async (job) => {
		const sent = await job.step(
			'send',
			() => ({ id: 'm1', at: new Date().toISOString() }),
			{ schema: z.object({ id: z.string(), at: z.string() }) },
		);
		const key: string = job.key('charge');
		return `${sent.id}:${key}`;
	});
}

/** The same queue wired through a Redis: its scope names the types too. */
export const wiredQueues = await openRedis(
	defineRedis({
		uri: 'redis://127.0.0.1:6379',
		prefix: 'myapp',
		queues: { mails, renders },
	}),
);

export const wiredMails = wiredQueues.queues.mails;

export function wiredWorker() {
	return wiredQueues.queues.renders.work(() => ({ bytes: 1 }));
}

export function closeWiredQueues() {
	return wiredQueues.close({ grace: '10s' });
}

/** A fresh retry: `RetryOptions` is nameable through the package. */
export function retried(options?: RetryOptions) {
	return mailQueue.retry('a', options);
}
