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
