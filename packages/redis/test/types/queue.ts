// What a queue refuses. Checked by `tsc --noEmit`, never run: a refusal that
// stops holding fails the typecheck on its unused directive.
import { RedisClient } from 'bun';
import { z } from 'zod';
import {
	type AddOptions,
	type BoundQueue,
	bindCache,
	bindIdempotency,
	bindQueue,
	bindRateLimit,
	type DebounceOptions,
	defineChannel,
	defineQueue,
	type Handler,
	type JobContext,
	JobError,
	type JobHandle,
	type JobState,
	type JobView,
	publish,
	type QueueCounts,
	type QueueErrorCode,
	type ResultInputOf,
	type ResultOf,
	type ThrottleOptions,
	type WorkerEvents,
	type WorkOptions,
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

// Flow control: a debounce or a throttle names the job by its key.
queue.add(
	{ to: 'a@b.c' },
	{ debounce: { key: 'a', wait: '30s' }, priority: 1 },
);
queue.add(
	{ to: 'a@b.c' },
	{ throttle: { key: 'a', window: '1h' }, delay: '1m' },
);
queue.add(
	{ to: 'a@b.c' },
	{ throttle: { key: 'a', window: 1000 }, at: new Date() },
);
// @ts-expect-error a debounce takes no id: its key names the job
queue.add({ to: 'a@b.c' }, { debounce: { key: 'a', wait: 1 }, id: 'x' });
// @ts-expect-error a debounce sets the run time itself, so no delay
queue.add({ to: 'a@b.c' }, { debounce: { key: 'a', wait: 1 }, delay: 1 });
// @ts-expect-error nor an at
queue.add({ to: 'a@b.c' }, { debounce: { key: 'a', wait: 1 }, at: new Date() });
// @ts-expect-error a throttle takes no id either
queue.add({ to: 'a@b.c' }, { throttle: { key: 'a', window: 1 }, id: 'x' });
queue.add(
	{ to: 'a@b.c' },
	{
		debounce: { key: 'a', wait: 1 },
		// @ts-expect-error debounce and throttle exclude each other
		throttle: { key: 'a', window: 1 },
	},
);
// @ts-expect-error a debounce needs its wait
queue.add({ to: 'a@b.c' }, { debounce: { key: 'a' } });
// @ts-expect-error a throttle needs its window, not a wait
queue.add({ to: 'a@b.c' }, { throttle: { key: 'a', wait: 1 } });
// @ts-expect-error a wait is a duration, and 'w' is not a unit
queue.add({ to: 'a@b.c' }, { debounce: { key: 'a', wait: '1w' } });
queue.addMany([
	{
		data: { to: 'a@b.c' },
		// @ts-expect-error addMany checks each item's options as add does
		options: { debounce: { key: 'a', wait: 1 }, id: 'x' },
	},
]);

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

// A rate limit needs both a limit and a per, and per is a duration.
defineQueue({
	name: 'x',
	schema: z.string(),
	rateLimit: { limit: 1, per: '1m' },
});
defineQueue({
	name: 'x',
	schema: z.string(),
	// @ts-expect-error '1 min' is not a unit
	rateLimit: { limit: 1, per: '1 min' },
});
// @ts-expect-error a rate limit needs a limit
defineQueue({ name: 'x', schema: z.string(), rateLimit: { per: '1m' } });
// @ts-expect-error nor does it go without the span it is counted over
defineQueue({ name: 'x', schema: z.string(), rateLimit: { limit: 1 } });

// `paused` is a boolean, not a count.
const paused: boolean = ({} as QueueCounts)['paused'];
const pausedIsNotANumber: QueueCounts['paused'] extends boolean ? true : never =
	true;
void [paused, pausedIsNotANumber];

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

// A result schema types what a handler returns and what `finished` resolves to.
const sized = defineQueue({
	name: 'sized',
	schema: z.string(),
	result: z.object({ id: z.string() }),
	timeout: '1m',
});
const sizedQueue = bindQueue(client, sized);
sizedQueue.work(() => ({ id: 'x' }));
sizedQueue.work(async () => ({ id: 'x' }));
// @ts-expect-error `id` is a string
sizedQueue.work(() => ({ id: 1 }));
// @ts-expect-error a queue with a result must return one
sizedQueue.work(() => {});
// A queue without a result ignores what its handler returns.
queue.work(() => ({ id: 'x' }));
queue.work(async () => 1);
queue.work(() => {});

const finishedId = async (): Promise<string> => {
	const handle = await sizedQueue.add('a');
	return (await handle.finished()).id;
};
void finishedId;
const finishedNothing = async (): Promise<undefined> =>
	(await queue.add({ to: 'a@b.c' })).finished({ timeout: '1s' });
void finishedNothing;
const finishedNothingId = async () => {
	const handle = await queue.add({ to: 'a@b.c' });
	// @ts-expect-error without a result schema finished holds `undefined`, not `any`
	return (await handle.finished()).id;
};
void finishedNothingId;
const finishedWeek = async () => {
	const handle = await queue.add({ to: 'a@b.c' });
	// @ts-expect-error a finished timeout is a duration, and 'w' is not a unit
	await handle.finished({ timeout: '1w' });
};
void finishedWeek;

// @ts-expect-error a timeout is a duration
defineQueue({ name: 'x', schema: z.string(), timeout: '1w' });
// @ts-expect-error a result is a schema
defineQueue({ name: 'x', schema: z.string(), result: 5 });
queue.add({ to: 'a@b.c' }, { timeout: '30s' });
// @ts-expect-error an add timeout is a duration, and 'w' is not a unit
queue.add({ to: 'a@b.c' }, { timeout: '1w' });

// The worker's events are named, and each carries its own payload.
const worker = queue.work(() => {});
worker.on('completed', (e) => e.duration.toFixed());
worker.on('failed', (e) => e.error.message.length);
// @ts-expect-error `completed` has no `nope`
worker.on('completed', (e) => e.nope);
// @ts-expect-error not an event
worker.on('nope', () => undefined);
void worker.close({ grace: '10s' });
// @ts-expect-error a grace is a duration, and 'w' is not a unit
void worker.close({ grace: '1w' });

queue.work((job) => {
	void job.signal.aborted;
	void job.progress(50);
	// @ts-expect-error progress is a number
	void job.progress('50');
});
const codes: QueueErrorCode[] = [
	'CANCELED',
	'FAILED',
	'WAIT_TIMEOUT',
	'TIMEOUT',
	'LEASE_LOST',
	'CLOSED',
];
void codes;

// Every type the lifecycle added is importable from the package entry.
const resultOf: ResultOf<z.ZodString> = 'x';
const noResult: ResultOf<undefined> = undefined;
const resultInput: ResultInputOf<z.ZodString> = 'x';
const handler: Handler<typeof mails.schema, undefined> = () => undefined;
const events: keyof WorkerEvents = 'completed';
const state: JobState = 'active';
const counts: QueueCounts = {} as QueueCounts;
const addOptions: AddOptions = { timeout: '1s' };
const debounced: DebounceOptions = { key: 'a', wait: '1s' };
const throttled: ThrottleOptions = { key: 'a', window: '1s' };
const workOptions: WorkOptions = { concurrency: 2 };
void [
	resultOf,
	noResult,
	resultInput,
	handler,
	events,
	state,
	counts,
	addOptions,
	debounced,
	throttled,
	workOptions,
];

// A durable step: without a schema it returns what `fn` returns, awaited.
queue.work(async (job) => {
	const plain: number = await job.step('a', () => 1);
	const awaited: string = await job.step('b', async () => 'x');
	void plain;
	void awaited;
	const key: string = job.key('send');
	void key;
	// With a schema it returns the output, and `fn` returns the input.
	const parsed: number = await job.step('c', () => '5', {
		schema: z.coerce.number(),
	});
	void parsed;
	// @ts-expect-error without a schema the value is not a string
	const wrong: string = await job.step('d', () => 1);
	void wrong;
	// @ts-expect-error with a schema `fn` returns the schema's input
	await job.step('e', () => true, { schema: z.string() });
	// @ts-expect-error the output is a number, not a string
	const out: string = await job.step('f', () => 1, { schema: z.number() });
	void out;
	// @ts-expect-error a key's name is a string
	job.key(1);
	// @ts-expect-error `schema` is a zod schema
	await job.step('x', () => 1, { schema: 5 });
});

// `retry` takes a boolean `fresh`, nothing else.
void queue.retry('a');
void queue.retry('a', {});
void queue.retry('a', { fresh: true });
void queue.retry('a', { fresh: false });
// @ts-expect-error `fresh` is a boolean, not a string
void queue.retry('a', { fresh: 'yes' });
// @ts-expect-error `fresh` is a boolean, not a number
void queue.retry('a', { fresh: 1 });

// Schedules: `data` is the schema's input, and a schedule is a cron or an
// interval, never both.
const scheduled = defineQueue({
	name: 'scheduled',
	schema: z.object({ to: z.string(), template: z.string().default('digest') }),
	schedules: {
		daily: { cron: '0 7 * * *', timezone: 'Europe/Paris', data: { to: '*' } },
		often: { every: '10m', data: { to: '*', template: 'ping' } },
		// @ts-expect-error `data` is checked against the schema
		wrong: { every: '1m', data: { to: 1 } },
		// @ts-expect-error a cron and an interval exclude each other
		both: { cron: '* * * * *', every: '1m', data: { to: '*' } },
		// @ts-expect-error a timezone goes with a cron
		zoned: { every: '1m', timezone: 'UTC', data: { to: '*' } },
		// @ts-expect-error a duration typo
		typo: { every: '10 minutes', data: { to: '*' } },
		// @ts-expect-error `data` is required
		bare: { every: '1m' },
	},
});
const scheduledQueue = bindQueue(client, scheduled);
const sq = scheduledQueue.schedules;
const d = { to: 'x' };
void sq.upsert('a', { cron: '* * * * *', data: d });
void sq.upsert('a', { every: 1000, data: d });
// @ts-expect-error `data` is checked against the schema
void sq.upsert('a', { every: '1m', data: { to: 1 } });
// @ts-expect-error a cron and an interval exclude each other
void sq.upsert('a', { cron: '* * * * *', every: '1m', data: d });
// @ts-expect-error a timezone goes with a cron
void sq.upsert('a', { every: '1m', timezone: 'UTC', data: d });
// @ts-expect-error a duration typo
void sq.upsert('a', { every: '10 minutes', data: d });
// @ts-expect-error the id is a string
void sq.remove(1);
void sq.list({ offset: 0, limit: 10 }).then((views) => {
	const next: Date = views[0]?.next ?? new Date();
	const template: string | undefined = views[0]?.data?.template;
	const every: number | undefined = views[0]?.every;
	const origin: 'definition' | 'runtime' = views[0]?.origin ?? 'runtime';
	void [next, template, every, origin];
});
// @ts-expect-error an unknown key is not an option
void sq.list({ page: 1 });

// A group is a string, and a queue's groups take a whole number as `concurrency`.
// @ts-expect-error a group is a string
queue.add({ to: 'a@b.c' }, { group: 1 });
queue.add({ to: 'a@b.c' }, { group: 'tenant-a', priority: 1 });
defineQueue({ name: 'g', schema: z.string(), groups: {} });
defineQueue({ name: 'g', schema: z.string(), groups: { concurrency: 2 } });
// @ts-expect-error concurrency is a number
defineQueue({ name: 'g', schema: z.string(), groups: { concurrency: '2' } });
// @ts-expect-error groups takes concurrency only
defineQueue({ name: 'g', schema: z.string(), groups: { weight: 2 } });
const viewGroup: string | undefined = (null as unknown as JobView<z.ZodString>)
	.group;
void viewGroup;

// @ts-expect-error a keyed channel is not a queue
bindQueue(
	client,
	defineChannel({
		name: 'k',
		schema: z.object({ id: z.string() }),
		key: (m) => m.id,
	}),
);
