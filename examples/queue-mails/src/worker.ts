import { type JobContext, openRedis } from '@nxgt/redis';
import type { mailSchema } from './mails';
import { type AppRedis, config } from './redis';

/** What the worker needs from outside: the provider, and a delivery record. */
export type Deps = {
	/** The provider; `idempotencyKey` is what it deduplicates on. */
	sendMail(mail: {
		to: string;
		tenantId?: string;
		subject: string;
		idempotencyKey: string;
	}): Promise<void>;
	/** Writes the delivery down (a database, in a real application). */
	recordSent(to: string): Promise<void>;
};

const handle = (deps: Deps) => async (job: JobContext<typeof mailSchema>) => {
	const { data } = job;
	const subject = data.kind === 'welcome' ? 'Welcome' : 'Your daily digest';
	const to = data.kind === 'welcome' ? data.to : 'ops@saas.test';
	const tenantId = data.kind === 'welcome' ? data.tenantId : undefined;
	// Each step runs once per job, however many attempts it takes. A crash
	// between the send and its commit is covered by the provider's key.
	await job.step('send', () =>
		deps.sendMail({
			to,
			subject,
			idempotencyKey: job.key('send'),
			...(tenantId ? { tenantId } : {}),
		}),
	);
	await job.step('record', () => deps.recordSent(to));
	return { subject };
};

/** Starts working the mails queue; schedules fire only while a worker runs. */
export function work(
	redis: AppRedis,
	deps: Deps,
	options: { concurrency?: number } = {},
) {
	return redis.queues.mails.work(handle(deps), options);
}

/** Works until SIGTERM or SIGINT, then lets the running jobs finish (20 s at most) and resolves. */
export function serve(redis: AppRedis, deps: Deps): Promise<void> {
	work(redis, deps, { concurrency: 8 });
	return new Promise((done) => {
		const stop = () => void redis.close({ grace: '20s' }).then(done);
		process.once('SIGTERM', stop);
		process.once('SIGINT', stop);
	});
}

// bun src/worker.ts: the provider is a log line here, no real SMTP.
if (import.meta.main) {
	const redis = await openRedis(config);
	await serve(redis, {
		sendMail: async (mail) => console.log('mail', mail),
		recordSent: async () => {},
	});
}
