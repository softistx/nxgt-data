// A queue an app exports, defined and bound, behind exported values whose
// types are inferred: a declaration build must be able to name each one
// through `@nxgt/redis` and its peers alone (TS2883 otherwise).
import { bindQueue, defineQueue } from '@nxgt/redis';
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
