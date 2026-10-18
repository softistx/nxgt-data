# Queues

Work that must happen, but not inside the request that asked for it — a mail, a
thumbnail, a webhook — described once, added from anywhere, and run by a
worker that survives a crash. Pub/sub drops a message nobody was listening for;
a queue keeps the job until a worker has finished it.

## The smallest thing that works

```ts
import { bindQueue, connectRedis, defineQueue } from '@nxgt/redis';
import { z } from 'zod';

export const mails = defineQueue({
	name: 'mails',
	schema: z.object({ to: z.string(), template: z.string().default('welcome') }),
});

const redis = await connectRedis(process.env.REDIS_URL!);
const queue = bindQueue(redis.client, mails);

await queue.add({ to: 'ada@example.com' });

const worker = queue.work(async ({ id, data }) => {
	await sendMail(data.to, data.template); // your code
});

// on shutdown: stop taking jobs, wait for the running ones
await worker.close();
```

`defineQueue` describes the queue and talks to nothing — put it where it is
imported, like a cache. `bindQueue(client, definition)` is what needs a client,
and takes any Bun `RedisClient`. The queue is bound by hand: it is not yet
wired by `defineRedis` (see [Wiring](#wiring)), so its keys carry no
deployment prefix, only the queue's `name`. Every key of one queue is `queue:{<name>}:…`, so they share a
Redis Cluster slot; for the same reason a name cannot contain braces.

## Defining a queue

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `name` | `string` | required | the queue's name, in its keys; no braces |
| `schema` | zod schema | required | the payload, checked on `add` and again before a handler sees it |
| `attempts` | `number` | `3` | runs of one job before it fails for good; a whole number, at least 1 |
| `backoff.base` | `Duration` | `1s` | the wait before the first retry, doubling from here |
| `backoff.max` | `Duration` | `1h` | the cap on that wait; `base` may not exceed it |
| `lease` | `Duration` | `30s` | how long a worker holds a job before another may take it back; at least 30 ms |
| `keepCompleted` | `false \| { age?: Duration; count?: number }` | `{ age: '1h', count: 1000 }` | how long finished jobs stay readable, and how many; `false` removes a job the moment it completes |
| `keepFailed` | `Duration` | `7d` | how long a failed job stays readable |
| `result` | zod schema | none | what a handler returns, checked when it returns and again when it is read; see [Results](#results) |
| `timeout` | `Duration` | none | how long one run may take before it is aborted and counted as a failed attempt; at least 1 ms; see [Timeouts](#timeouts-and-the-abort-signal) |

A `Duration` is a whole number of milliseconds, or a string with a unit —
`'250ms'`, `'30s'`, `'10m'`, `'2h'`, `'7d'`. A fraction is fine in a string
(`'1.5s'`) as long as it is a whole number of milliseconds.

```ts
export const thumbnails = defineQueue({
	name: 'thumbnails',
	schema: z.object({ imageId: z.string() }),
	attempts: 5,
	lease: '2m',                       // a slow resize holds its job for two minutes
	backoff: { base: '2s', max: '10m' },
	keepCompleted: { age: '10m', count: 100 },
	keepFailed: '30d',
});
```

`defineQueue` returns the definition frozen, every option resolved and every
span in milliseconds. A definition that could never work is a `TypeError`
thrown there — normally at import (see
[troubleshooting](../troubleshooting.md#queues)). `bindQueue` checks it again,
for a definition written by hand.

The payload is stored as JSON: the schema's **output**, defaults applied (the
mail above is stored with its `template`). A value JSON cannot carry — a `Date`,
a `Map`, a `bigint` — is refused at `add`, not when a worker claims the job.
Send a date as an ISO string and parse it in the schema.

## Adding jobs

```ts
const handle = await queue.add({ to: 'ada@example.com' });
// { id: '0199…', deduplicated: false }
```

`add` is one script, one round trip. The payload is checked by the schema; a
refusal is a `QueueError` with `code: 'INVALID'`, and nothing is written.

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `id` | `string` | a UUID v7 | the job's id, 1 to 256 characters, no braces. Adding an id that is already in the queue keeps the first job and says so |
| `priority` | `number` | `0` | a whole number, 0 to 1000; a **lower** one runs first. Within a priority, first added is first run |
| `delay` | `Duration` | none | the job becomes due after this long |
| `at` | `Date` | none | the job becomes due then; a time in the past is due now. Give `delay` or `at`, not both |
| `timeout` | `Duration` | the queue's | overrides the queue's `timeout` for this job; the per-job value wins |

```ts
// Run in ten minutes, ahead of the ordinary jobs.
await queue.add({ to: 'ada@example.com' }, { delay: '10m', priority: 1 });

// Run at a given time.
await queue.add({ to: 'ada@example.com' }, { at: new Date('2027-01-01T09:00:00Z') });

// One job per order, however often the request is retried.
const first = await queue.add({ to: 'ada@example.com' }, { id: `receipt:${orderId}` });
const again = await queue.add({ to: 'ada@example.com' }, { id: `receipt:${orderId}` });
// first.deduplicated === false, again.deduplicated === true
```

A job's `delay` and `at` are measured on the Redis server's clock. An id stays
taken for as long as the job is stored — until it is removed, or trimmed by
`keepCompleted` or `keepFailed` — so a deduplicated id is not only for jobs
still waiting.

`addMany` takes `{ data, options? }` items and returns the handles in the order
given:

```ts
const handles = await queue.addMany([
	{ data: { to: 'ada@example.com' } },
	{ data: { to: 'grace@example.com' }, options: { id: 'welcome:grace' } },
]);
```

One bad item refuses the whole call before anything is written. An id repeated
inside the batch keeps its first item.

`add` returns a `JobHandle`, which can wait for the job and cancel it; see
[Waiting for a job](#waiting-for-a-job).

## Results

A queue may declare what its handler returns, as a zod schema:

```ts
import { bindQueue, defineQueue } from '@nxgt/redis';
import { z } from 'zod';

const resizes = defineQueue({
	name: 'resizes',
	schema: z.object({ imageId: z.string() }),
	result: z.object({ url: z.string(), bytes: z.number() }),
});

const queue = bindQueue(redis.client, resizes);

queue.work(async ({ data }) => {
	const { url, bytes } = await resize(data.imageId); // your code
	return { url, bytes };
});

const handle = await queue.add({ imageId: 'img-1' });
const { url } = await handle.finished(); // { url: string; bytes: number }
```

- **Without `result`**, a handler may return anything; the value is ignored and
  never stored, and `finished()` resolves to `undefined`.
- **With `result`**, the handler's return is validated by the schema and stored
  as its output. A return the schema refuses, or JSON cannot carry, fails the
  job `INVALID` **without a retry**: the same code would return the same value.
  The stored error is `INVALID: the result does not match the result schema`,
  with no value in it.
- **`undefined`** passes only when the schema accepts it (`z.void()`,
  `.optional()`). Otherwise a handler that returns nothing fails `INVALID`.
- The result is stored as JSON, so, like a payload, it cannot hold a `Date`, a
  `Map` or a `bigint`. It is read back through the schema again.

```ts
type ResultInputOf<R> = R extends z.ZodType ? z.input<R> : unknown; // what a handler returns
type ResultOf<R> = R extends z.ZodType ? z.output<R> : undefined;   // what `finished` and `get` give
```

## Waiting for a job

```ts
import { QueueError } from '@nxgt/redis';

const handle = await queue.add({ imageId: 'img-1' });

try {
	const result = await handle.finished({ timeout: '30s' });
} catch (error) {
	if (error instanceof QueueError && error.code === 'WAIT_TIMEOUT') {
		// still running: the job is untouched, ask again later
	} else throw error;
}

const canceled: boolean = await handle.cancel(); // or queue.cancel(handle.id)
```

```ts
type JobHandle<R> = {
	readonly id: string;
	readonly deduplicated: boolean;
	finished(options?: { timeout?: Duration }): Promise<ResultOf<R>>;
	cancel(): Promise<boolean>;
};
```

`finished` resolves with the job's result, or rejects with a `QueueError`:

| `code` | When |
| --- | --- |
| `FAILED` | the job failed for good; `error.lastError` is `{ name, message }` of the last failure |
| `CANCELED` | the job was canceled |
| `NOT_FOUND` | the job is not in the queue |
| `WAIT_TIMEOUT` | `timeout` passed first; the job itself is not touched |
| `INVALID` | the stored result no longer matches the result schema |

A malformed `timeout` is a `TypeError`; it is at least 1 ms. There is no
deadline unless you give one. When you do, it is a hard bound: `finished`
rejects `WAIT_TIMEOUT` on time even if the Redis connection hangs, so a stuck
read, `SUBSCRIBE` or subscriber flush cannot defer it.

- **`NOT_FOUND` is also what a finished job reads as when it is gone.** A job on
  a queue with `keepCompleted: false` that finished before `finished` was
  called, or whose outcome event was missed, is deleted, so it reads as
  `NOT_FOUND` and not as a result. Keep completed jobs if callers wait on them.
- **While it waits**, `finished` listens for the job's outcome and also
  re-reads the job every 5 seconds as a safety net, so an event a dropped
  connection lost delays the answer by at most that.
- **`cancel()`** and `queue.cancel(id)` are the same call. They return `true`
  when the job was waiting, delayed or running (a running job's handler is
  aborted with `CANCELED`), and `false` when there was nothing to cancel:
  finished, removed or unknown. A canceled job is deleted.

## Timeouts and the abort signal

`timeout` bounds one run. It is set on the queue and may be overridden per job;
the per-job value wins. A duration is milliseconds or a string such as `'10m'`.

```ts
const reports = defineQueue({
	name: 'reports',
	schema: z.object({ id: z.string() }),
	timeout: '10m',
});

const queue = bindQueue(redis.client, reports);
await queue.add({ id: 'monthly' });                    // runs up to 10 minutes
await queue.add({ id: 'quick' }, { timeout: '30s' });  // this one, 30 seconds
```

A run that passes its timeout is aborted and counts as a failed attempt, so it
is retried by the backoff like any other failure. A timeout above about 24.8
days (2147483647 ms, the longest a timer waits) runs as 24.8 days.

The handler gets an `AbortSignal` in `job.signal`. It aborts when the run ends
by something other than the handler: `signal.reason` is a `QueueError` whose
`code` says why.

| `signal.reason.code` | The run was aborted because |
| --- | --- |
| `CANCELED` | the job was canceled |
| `TIMEOUT` | it ran past its `timeout` |
| `LEASE_LOST` | its lease lapsed and another worker may have taken the job |
| `CLOSED` | the worker closed and its grace passed |

Pass the signal to whatever can stop, so the work really ends:

```ts
queue.work(async ({ data, signal }) => {
	const response = await fetch(data.url, { signal }); // aborts with the run
	return { bytes: (await response.arrayBuffer()).byteLength };
});
```

A handler that **ignores** its signal is abandoned: the worker frees its slot at
once, settles the job by the abort (a retry, for a timeout or a lost lease), and
drops the handler's late return. The handler's code still runs to its end, with
whatever side effects it has, so check `signal.aborted` between steps.

## Progress

`job.progress(value)` reports how far the job is, a number from 0 to 100. It is
stored, emitted as a `progress` event, and shown by `get` and `list` as
`JobView.progress` (0 until the job reports). Anything else is a `TypeError`;
after the run has been aborted it does nothing.

```ts
queue.work(async ({ data, progress }) => {
	for (const [index, page] of data.pages.entries()) {
		await render(page); // your code
		await progress(Math.round(((index + 1) / data.pages.length) * 100));
	}
});

const view = await queue.get('monthly'); // view?.progress
```

## The worker

```ts
const worker = queue.work(
	async ({ id, data, attempt, attempts }) => {
		await sendMail(data.to, data.template);
	},
	{ concurrency: 4 },
);

worker.on('error', (error) => logger.error({ error }, 'queue worker'));
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `concurrency` | `number` | `1` | jobs run at once; a whole number, 1 to 1000 |

A handler receives `{ id, data, attempt, attempts, signal, progress, step, key }`: the id,
the payload parsed by the schema, this run counting from 1, the runs the queue
allows, the [abort signal](#timeouts-and-the-abort-signal) and the
[progress](#progress) reporter, and the [durable steps](#running-twice) `step` and `key`. What it settles:

- **returns** (or resolves): the job completes. The value is stored when the
  queue has a [result schema](#results), ignored otherwise.
- **throws**: the job is retried after a backoff, or fails once its attempts are
  spent — see [Retries](#retries-and-backoff).

`work` returns a `Worker`:

```ts
type Worker = {
	close(options?: { grace?: Duration }): Promise<void>;
	idle(): Promise<void>;
	on<E extends keyof WorkerEvents>(
		event: E,
		listener: (payload: WorkerEvents[E]) => void,
	): () => void;
	[Symbol.asyncDispose](): Promise<void>;
};
```

- `on(event, listener)` returns the function that stops the listening; a
  listener that throws is ignored. See [Events](#worker-events).
- An idle worker waits on a blocking connection of its own, so a job added
  now is picked up at once; a delayed one when it falls due. A busy worker
  spends about one round trip per job.

### Closing

`close({ grace })` stops taking jobs and resolves once the running ones have
finished, or once `grace` has passed (default 30 seconds, a `Duration`). The
handlers still running then are aborted with `CLOSED`, and their leases are left
to lapse, so another worker retakes the jobs. Only the **first call's** `grace`
counts; a later call gets the same promise. Call it on shutdown.
`await using worker = queue.work(…)` closes it, with the default grace, at the
end of the block.

```ts
process.on('SIGTERM', async () => {
	await worker.close({ grace: '10s' }); // finish what runs, abort the rest after 10 s
	process.exit(0);
});
```

### Idle

`idle()` resolves when no slot is running and the last claim found nothing
ready, at once when that already holds, and at once after `close`. A job claimed
afterwards re-arms it. It is for tests and scripts that drain a queue:

```ts
await queue.addMany(items);
await worker.idle(); // everything due has run
```

A job that was aborted frees its slot at once, so `idle` can resolve while a
handler that ignored its signal is still running. A delayed job that is not yet
due does not hold it back.

### Worker events

```ts
type WorkerEvents = {
	active: { id: string; attempt: number };
	progress: { id: string; progress: number };
	completed: { id: string; attempt: number; duration: number }; // ms
	retrying: { id: string; attempt: number; delay: number; error: { name: string; message: string } };
	failed: { id: string; attempt: number; error: { name: string; message: string } };
	stalled: { id: string };
	canceled: { id: string };
	error: unknown;
};
```

```ts
const stop = worker.on('completed', ({ id, duration }) => {
	metrics.timing('job', duration, { id }); // your code
});
worker.on('failed', ({ id, error }) => logger.warn({ id, error }, 'job failed'));
worker.on('error', (error) => logger.error({ error }, 'queue worker'));
stop(); // stop listening to completed
```

- `retrying`: a run failed and the job returns after `delay` milliseconds.
  `failed`: it failed for good.
- `stalled`: a run lost its lease and was taken back.
- `canceled`: a running job was canceled. A cancel that lands while the
  handler's completion is being settled emits nothing.
- A job the claim found unreadable (its stored payload does not parse) emits
  `failed` with `attempt: 0` and an `INVALID` error.
- `error` is what the loop could not handle: Redis went away, a settle failed.
  The worker keeps going, waiting longer between tries (1 s, doubling to
  30 s). A **handler's** error is not reported there: it is the job's failure,
  kept on the job.

A worker for the same queue can run in any number of processes; each job goes
to one of them.

### At-least-once

A job runs **at least once**, not exactly once. A worker holds each job under a
lease (`lease`, 30 s by default) and renews it every third of that while the
handler runs. If the process dies, or loses Redis for a whole lease, the lease
lapses and another worker runs the job again — possibly while the first run is
still going. The first run's late result is refused: it cannot complete or fail
a job it no longer holds.

So write handlers that can run twice:

```ts
queue.work(async ({ id, data }) => {
	// The job id is the same on every run: hand it to the provider as the key
	// it deduplicates on, so a second run charges nothing.
	await provider.send(data.to, { idempotencyKey: id });
});
```

`id` is stable across runs and retries, which makes it the natural idempotency
key; give the job an `id` of your own at `add` where the work has a natural one.
A handler that makes several side effects must record which it has done: that
is what [steps](#running-twice) are for.

## Running twice

A job runs at least once, so a handler can run more than once for the same job:
its process died, it lost its lease, or it ran past `timeout`. **Code outside a
step runs again on every attempt.** `job.step(name, fn)` commits a side
effect's value once per job instead, and `job.key(name)` covers the rare run
twice.

```ts
import { bindQueue, connectRedis, defineQueue } from '@nxgt/redis';
import { z } from 'zod';

const redis = await connectRedis(process.env.REDIS_URL!);

const digests = defineQueue({
	name: 'digest',
	schema: z.object({ family: z.string() }),
});

const queue = bindQueue(redis.client, digests);

queue.work(async (job) => {
	const families = await job.step('load', async () => [job.data.family]);
	await job.step('send', async () => {
		await mailer.send(families, { idempotencyKey: job.key('send') });
	});
});
```

A step's value is committed once per job: an attempt that reaches a step
already stored gets the value back without calling `fn`. A step that returns
nothing, like `send` above, is stored too. The fence is checked at the step's
edges, not while `fn` runs, so `fn` may still run more than once (a crash, or a
lease lapsing mid-`fn`): pass `job.key(name)` downstream, as `send` does, so the
other side deduplicates.

```ts
type StepOptions<Z extends z.ZodType> = { schema: Z };

step<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
step<Z extends z.ZodType>(
	name: string,
	fn: () => z.input<Z> | Promise<z.input<Z>>,
	options: StepOptions<Z>,
): Promise<z.output<Z>>;
key(name: string): string;
```

### Values and schemas

Without a schema, the value must survive JSON; a `Date`, a `Map` or a `NaN` is
refused rather than read back as something else. With `{ schema }`, `fn` returns
the schema's input, the step returns its output, and a stored value is parsed
again on every read, so a schema can turn the stored text back into a `Date`:

```ts
const sentAt = await job.step(
	'send',
	async () => {
		await mailer.send(job.data.family);
		return new Date().toISOString();
	},
	{ schema: z.string().transform((text) => new Date(text)) },
);
// sentAt is a Date, on the first run and on every later one
```

### The rules

- A name is 1 to 128 characters without `:`; anything else is a `TypeError`.
- Names appear in error messages and in the stored error, so they count as
  structure, like a job id: build them from ids, never from secrets or personal
  data.
- A name runs **once per attempt**: using it twice is a `TypeError`. A loop
  needs distinct names, such as `send-${i}`.
- A throw from `fn` is the handler's own error and stores nothing, but the name
  stays used for the rest of that attempt.
- Distinct steps may run concurrently, for example inside `Promise.all`.

```ts
for (const [i, to] of job.data.recipients.entries()) {
	await job.step(`send-${i}`, () => mailer.send(to));
}
```

### Fencing

A step's value is committed once and never overwritten by a stale attempt. A
step starts only if this attempt still holds the job and its lease has not
lapsed, and its value is stored only under the same check. A worker whose lease
lapsed, or whose job was taken over, gets a `QueueError` with code `LEASE_LOST`
from `step`. Its run is aborted (its `signal` fires), and the live attempt's
value is the one stored.

The fence is checked at the step's edges (begin and commit), not while `fn`
runs, so `fn` may run more than once: after a crash, or when the lease lapses
mid-`fn` and another attempt runs the step too. Make `fn` safe to repeat, and
pass `job.key(name)` downstream. A run aborted while `fn` ran still commits the
value (the commit is the fence), and the step then rejects with the abort
reason.

### `job.key(name)`

`job.key('send')` is `<queue>:<job id>:send`, the same on every attempt (once
the queue is [wired](#wiring) under a prefix, it starts with the prefix:
`<prefix>:<queue>:<job id>:send`). A
crash can still land between the side effect and the step's commit, so hand the
key to the other side as its idempotency key, as the first example does with the
mailer's. `name` follows the rules of a step's, and a queue name cannot hold
`:`, so the key is unambiguous.

The key is per job id and outlives `remove`: adding the same id again gets the
same key, so the other side still deduplicates.

Two deployments that hand keys to **one** downstream provider need prefixes
that are not prefixes of each other, segment by segment. With the prefixes
`app` and `app:x`, queue `x` with job id `y:1` and queue `y` with job id `1`
both give `app:x:y:1:<step>`. Nothing enforces it; pick prefixes such as
`app:prod` and `app:staging`.

Where the other side has no such key, wrap the call in an
[idempotent operation](guard/idempotency.md) and key it with the job's:

```ts
import { bindIdempotency, defineIdempotency } from '@nxgt/redis';
import { z } from 'zod';

declare function chargeCard(family: string): Promise<{ chargeId: string }>; // your code

const charges = bindIdempotency(
	redis.client,
	defineIdempotency({
		name: 'charges',
		key: (p: { key: string }) => p.key,
		ttl: 86_400,
		schema: z.object({ chargeId: z.string() }),
	}),
);

queue.work(async (job) => {
	await job.step('charge', async () => {
		const { value } = await charges.run({ key: job.key('charge') }, () =>
			chargeCard(job.data.family),
		);
		return value;
	});
});
```

### Persistence and cost

Steps survive retries and `retry(id)`: a job that failed at its third step
resumes there. `remove(id)`, and adding the job afresh, starts over.

A step that runs costs two round trips (a begin, which also pushes the lease a
full lease ahead, and a commit); a stored one costs one.

### Errors

A value that cannot be stored, or a stored one the schema refuses, rejects with
a `QueueError` `INVALID`, which fails the job without retry: only a step's own
refusal does, while any other `INVALID` the handler throws is retried as usual.
The messages name the queue and the step, never the value. `LEASE_LOST` is
described above. See [troubleshooting](../troubleshooting.md#queues) for the
messages.

## Retries and backoff

A handler that throws is retried until `attempts` runs have been spent, then the
job is `failed`. The wait before retry number *n* is a random span below
`min(max, base × 2^(n-1))` — full jitter, so workers that failed together do not
retry together.

`JobError` says how one failure is retried:

| You throw | The job |
| --- | --- |
| any other error | is retried by the backoff |
| `new JobError(message)` | the same |
| `new JobError(message, { retry: false })` | fails for good now, whatever attempts remain |
| `new JobError(message, { retryIn: '5m' })` | is retried after exactly that long, instead of the backoff's wait |

```ts
import { JobError } from '@nxgt/redis';

queue.work(async ({ data }) => {
	const response = await fetch(`https://api.example.com/send`, { method: 'POST', body: JSON.stringify(data) });
	if (response.status === 429) {
		const wait = Number(response.headers.get('Retry-After') ?? 60);
		throw new JobError('rate limited', { retryIn: wait * 1000 });
	}
	if (response.status === 400) {
		throw new JobError('the provider refuses this payload', { retry: false });
	}
	if (!response.ok) throw new Error(`provider answered ${response.status}`);
});
```

`retry: false` and `retryIn` exclude each other, and the types enforce it:
giving up and choosing a delay say opposite things, so
`new JobError('x', { retry: false, retryIn: '5m' })` does not compile.

`retryIn` is a `Duration`; a malformed one throws a `TypeError` when the
`JobError` is built. A retry that is `retryIn`-timed still counts as an attempt.

The failure is kept on the job as `{ name, message }` — never the stack — so a
message should not quote the payload. A job whose stored payload no longer
matches the schema (the schema changed under a waiting job) is failed at once,
never run.

## Retention

`keepCompleted` and `keepFailed` decide how long a finished job stays readable
through `get` and `list`:

```ts
defineQueue({
	name: 'audit',
	schema,
	keepCompleted: { age: '24h', count: 5000 }, // newest 5000, none older than a day
	keepFailed: '30d',
});

defineQueue({ name: 'fire-and-forget', schema, keepCompleted: false });
```

With `keepCompleted: false` a job is deleted the moment it completes, and its id
is free again. Otherwise the id stays taken (so `add` deduplicates against it)
until the job is trimmed.

## Inspecting and repairing

```ts
const counts = await queue.counts();
// { waiting: 3, delayed: 1, active: 2, completed: 40, failed: 1 }

const failed = await queue.list('failed', { limit: 20 });
for (const job of failed) console.log(job.id, job.attempt, job.error);

const one = await queue.get('receipt:42'); // JobView | undefined

await queue.retry('receipt:42');  // a failed job goes back to waiting, attempts from 0
await queue.remove('receipt:41'); // any state but active
```

| Call | Returns | Throws |
| --- | --- | --- |
| `get(id)` | the `JobView`, or `undefined` | |
| `list(state, { offset?, limit? })` | a page of `JobView`s; `offset` from 0 (default 0), `limit` 1 to 1000 (default 50) | `TypeError` for an `offset` or `limit` out of range, or an unknown state |
| `counts()` | `Record<JobState, number>`, from one script | |
| `retry(id)` | nothing | `QueueError` `NOT_FOUND` when the job is not failed |
| `remove(id)` | nothing | `QueueError` `ACTIVE` for a running job, `NOT_FOUND` for none |

```ts
type JobState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed';

type JobView<S, R> = {
	id: string;
	state: JobState;
	data: z.output<S> | undefined; // undefined when the stored payload no longer parses
	attempt: number;
	attempts: number;
	priority: number;
	error?: { name: string; message: string }; // the last failure
	added: Date;
	runAt: Date;                   // when the job is next due
	finished?: Date;
	progress: number;              // 0 until the handler reports
	result?: ResultOf<R>;          // once the job has completed
};
```

`waiting`, `delayed` and `active` are listed oldest first, in the order they
will be taken; `completed` and `failed` newest first. A job removed while the
page is read is left out, so a page can be shorter than `limit`.

A realistic use — a Hono route that lists what failed and lets an operator put
a job back:

```ts
import { Hono } from 'hono';
import { QueueError } from '@nxgt/redis';

export const admin = new Hono()
	.get('/mails/failed', async (c) => c.json(await queue.list('failed')))
	.post('/mails/:id/retry', async (c) => {
		try {
			await queue.retry(c.req.param('id'));
			return c.body(null, 204);
		} catch (error) {
			if (error instanceof QueueError && error.code === 'NOT_FOUND') return c.notFound();
			throw error;
		}
	});
```

`QueueError` carries `code`, `queue` (the name), `job` (the id, when the call
was about one) and, for `FAILED`, `lastError`. Its message names the queue and the job, never the payload.

## Wiring

`defineRedis` wires queues like caches and guards: pass the module that exports
the `defineQueue` calls, and every one comes back as `redis.queues.<key>` under
the deployment's prefix, with its workers closed by `redis.close()`.

```ts
import { defineRedis, openRedis } from '@nxgt/redis';
import * as queues from './queues'; // every `defineQueue` of the app

export const redis = await openRedis(
	defineRedis({ uri: process.env.REDIS_URL!, prefix: 'myapp:prod', queues }),
);

await redis.queues.mails.add({ to: 'ada@example.com' });

redis.queues.mails.work(async ({ data }) => {
	await sendMail(data.to); // your code
});

process.on('SIGTERM', async () => {
	await redis.close({ grace: '20s' });
	process.exit(0);
});
```

`redis.queues.mails` is the object `bindQueue` returns, and its `definition` is
the `mails` you exported, unchanged. Errors still name the definition's own
name (`add on "mails": …`).

### Keys and the prefix

The prefix goes inside the queue's hash tag: the keys are
`queue:{myapp:prod:mails}:…`, so one queue's keys still share a Redis Cluster
slot. A queue bound by hand and the same queue wired under a prefix are two
different sets of keys: moving one under a prefix starts empty, and the jobs
left under the old keys are not seen. Without a prefix, the wired keys are those
of `bindQueue`. A prefix holding `{` or `}` is refused when the instance wires a
queue, and `defineRedis` refuses one name wired twice, or shared with a cache,
rate limit or idempotent operation; see
[troubleshooting](troubleshooting.md#queues).

### Nothing opens early

Reading `redis.queues` or `redis.queues.mails` sends nothing. The first
`work()` or `finished()` opens the shared subscriber (a `work` listens for
cancels), and a worker that finds nothing ready opens a blocking connection of
its own. A Redis built on a handed-in `client` opens no connection of its own
for the queue.

### Closing the Redis

`redis.close({ grace })` closes the queues first, in two phases, then the
subscriptions, then the clients. `grace` is a `Duration`, and leaving it out
gives each worker its default, 30 seconds.

```ts
type Close = (options?: { grace?: Duration }) => Promise<void>;
```

1. **Closing.** `work` throws `QueueError` `CLOSED` from the moment `close` is
   called, and every worker started through `redis.queues` closes with the
   grace. `add`, `addMany` and `finished` still work, so a running handler can
   add jobs to other queues, and a `finished` whose job completes during the
   grace resolves with its result.
2. **Closed.** `add`, `addMany` and `finished` throw `CLOSED`, and every
   `finished` still waiting rejects `CLOSED`.

```ts
import { QueueError } from '@nxgt/redis';

await redis.close({ grace: '20s' });

try {
	await redis.queues.mails.add({ to: 'ada@example.com' });
} catch (error) {
	if (error instanceof QueueError && error.code === 'CLOSED') {
		// the process is going down: do not retry here
	}
}
```

- Admin calls (`get`, `list`, `counts`, `retry`, `remove`, `cancel`) pass
  through after the close. On a connection the Redis opened they fail with the
  client's own error; on a handed-in client they still work.
- An `add` in flight when the connection closes fails with the connection's
  error, not `CLOSED`. An `addMany` stops between its chunks with `CLOSED`.
- A queue bound by hand (`bindQueue`) never throws `CLOSED`; close its worker
  yourself.
- `close` is memoised: a second call returns the first call's promise, and its
  `grace` is ignored.
- A malformed `grace` rejects with a `TypeError` before anything closes.
- A job still running when the grace ends is aborted with `CLOSED`, its lease
  lapses, and another worker retakes it as one more attempt: see
  [Closing](#closing) and [Running twice](#running-twice).

The platform has its own kill timeout (Kubernetes' `terminationGracePeriodSeconds`,
a container's stop timeout): keep `grace` below it, or the process is killed
mid-close.

## Testing

`@nxgt/redis/testing` starts a real Redis; see the
[testing guide](guard/testing.md) for installing it and building it ahead.

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { bindQueue } from '@nxgt/redis';
import { startTestRedis, type TestRedis } from '@nxgt/redis/testing';
import { mails } from '../src/queues';

let server: TestRedis;
let client: RedisClient;

beforeAll(async () => {
	server = await startTestRedis();
	client = new RedisClient(server.uri);
}, 180_000);

beforeEach(() => server.reset());

afterAll(async () => {
	client.close();
	await server.stop();
});

test('a welcome mail is sent once', async () => {
	const queue = bindQueue(client, mails);
	const sent: string[] = [];
	await using worker = queue.work(({ data }) => void sent.push(data.to));

	await queue.add({ to: 'ada@example.com' }, { id: 'welcome:ada' });
	while ((await queue.counts()).completed < 1) await Bun.sleep(10);

	expect(sent).toEqual(['ada@example.com']);
});
```

A test can also wait with `await worker.idle()`, or on one job with
`await handle.finished({ timeout: '5s' })`, instead of polling `counts`.

Define the queue with a short `lease` and `backoff` in a test, so a spec that
waits for a retry waits milliseconds rather than seconds.

## Round trips

| Call | Round trips |
| --- | --- |
| `add` | 1 |
| `addMany` | 1 per 500 jobs |
| a busy worker | about 1 per job: it settles a job and claims the next in the same script |
| an idle worker | none while it waits; it blocks on a connection of its own |
| `job.step` | 2 when it runs, 1 when its value is already stored |
| `counts` | 1 |
| `list` | 1 for the ids, and the jobs' reads pipelined into 1 more |

See also [Pub/sub](channels.md), for events nobody has to be sure received, and
[Locks](locks.md), for work that must not overlap.
