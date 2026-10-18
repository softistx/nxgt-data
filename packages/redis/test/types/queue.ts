// What a queue refuses. Checked by `tsc --noEmit`, never run: a refusal that
// stops holding fails the typecheck on its unused directive.
import { RedisClient } from 'bun';
import { z } from 'zod';
import {
	type BoundQueue,
	bindCache,
	bindIdempotency,
	bindQueue,
	bindRateLimit,
	defineQueue,
	type JobContext,
	JobError,
	type JobHandle,
	type JobView,
	publish,
	type QueueErrorCode,
} from '../../src';
import { createOrder, loginLimit, userCache, userCreated } from '../fixtures';

const client = new RedisClient('redis://127.0.0.1:1');
const mails = defineQueue({
	name: 'mails',
	schema: z.object({
		to: z.string(),
		template: z.string().default('welcome'),
	}),
});
const queue = bindQueue(client, mails);

// A field the schema defaults may be left out of `add`.
const added: Promise<JobHandle> = queue.add({ to: 'a@b.c' });
void added;
queue.add({ to: 'a@b.c', template: 'reset' }, { delay: '10m', priority: 5 });
queue.add({ to: 'a@b.c' }, { at: new Date() });

// The handler sees the schema's output, the default applied.
queue.work((job) => {
	const template: string = job.data.template;
	void template;
});
const typed: BoundQueue<
	z.ZodObject<{ to: z.ZodString; template: z.ZodDefault<z.ZodString> }>
> = queue;
void typed;
const context = (job: JobContext<typeof mails.schema>) => job.data.to;
void context;
const view = async (): Promise<JobView<typeof mails.schema> | undefined> =>
	queue.get('j1');
void view;

// A payload of the wrong shape.
// @ts-expect-error `to` is a string
queue.add({ to: 1 });

// A delay is a number of milliseconds or a string with a unit.
// @ts-expect-error '10min' is not a unit
queue.add({ to: 'a@b.c' }, { delay: '10min' });

// `delay` and `at` are two ways to say the same thing.
// @ts-expect-error not both
queue.add({ to: 'a@b.c' }, { delay: 1000, at: new Date() });

// @ts-expect-error a priority is a number
queue.add({ to: 'a@b.c' }, { priority: '1' });

queue.work((job) => {
	// @ts-expect-error the payload has no `nope`
	return job.data.nope;
});

defineQueue({
	name: 'x',
	schema: z.string(),
	// @ts-expect-error not an option
	retries: 3,
});

// @ts-expect-error a lease unit that does not exist
defineQueue({ name: 'x', schema: z.string(), lease: '1w' });

// The codes a refusal can carry.
const code: QueueErrorCode = 'ACTIVE';
void code;
// @ts-expect-error not a code
const bad: QueueErrorCode = 'LOST';
void bad;

// A queue is none of the other kinds, and none of them is a queue: each has
// a field the other lacks, or declares it `never`.
// @ts-expect-error a queue is not a cache
bindCache(client, mails);
// @ts-expect-error a queue is not a rate limit
bindRateLimit(client, mails);
// @ts-expect-error a queue is not an idempotent operation
bindIdempotency(client, mails);
// @ts-expect-error a queue is not a channel
publish(client, mails, { to: 'a@b.c', template: 'welcome' });
// @ts-expect-error a cache is not a queue
bindQueue(client, userCache);
// @ts-expect-error a rate limit is not a queue
bindQueue(client, loginLimit);
// @ts-expect-error an idempotent operation is not a queue
bindQueue(client, createOrder);
// @ts-expect-error a channel is not a queue
bindQueue(client, userCreated);

// A state the queue does not have.
// @ts-expect-error 'done' is not a state
queue.list('done');

// JobError says how one failure is retried: give up, or choose a delay.
new JobError('x');
new JobError('x', { retry: false });
new JobError('x', { retryIn: '10m' });
// @ts-expect-error `retry: true` is what leaving it out already means
new JobError('x', { retry: true });
// @ts-expect-error '10min' is not a unit
new JobError('x', { retryIn: '10min' });
// @ts-expect-error giving up and choosing a delay say opposite things
new JobError('x', { retry: false, retryIn: '1s' });

// @ts-expect-error `grace` is not an option of `work`
queue.work(() => undefined, { grace: 1 });

// @ts-expect-error every item's payload is checked, as `add`'s is
queue.addMany([{ data: { to: 1 } }]);
