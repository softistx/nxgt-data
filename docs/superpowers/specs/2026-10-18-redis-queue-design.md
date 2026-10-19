# A queue in `@nxgt/redis` — design

Date: 2026-10-18. Status: approved by the owner through a grilling session
(27 decisions, listed at the end); this document is what the implementation
plan is written from.

## Why

The owner's rule says `@nxgt/redis` covers "cache, rate limits, queues"; the
package says "It is not a queue" and lists a queue under *Not planned*. The
owner chose to make the rule true. The first consumer in view is a backend
that runs a daily per-family digest and an hourly files sweep on an external
cron today, and wants to move both onto a queue.

The owner asked for a queue that is **modern, feature-rich, fast, and
intuitive to use**.

## Success

- A job added is run at least once, even if the process running it dies.
- A recurring job declared once is enqueued once per occurrence across every
  process, at the right local time across daylight-saving changes.
- Every operation's round trips to Redis are pinned by a spec, and a local
  benchmark publishes throughput and latency in the guide.
- A consumer writes a producer and a worker in a few lines, with the payload,
  the result and every option checked by the types.

## Not in this version

- **Flows** (a parent waits for its children) — roadmap *Next*; the job hash
  leaves room for a `parent` field.
- **A batch handler** (`workBatch`) — roadmap *Next*; CLAIM already takes N
  jobs per round trip.
- **A rate limit per group** — roadmap *Next*; per-group concurrency covers
  fairness.
- **`promote`, `changeDelay`, `changePriority`, `drain`, `obliterate`** —
  roadmap *Later*, built when a consumer asks.
- **An in-memory fake** — tests run against the real scripts on
  `startTestRedis()`.
- **An OpenTelemetry dependency** — typed in-process events; the application
  wires them to its own telemetry.

## Shape of the API

```ts
import { z } from 'zod';
import { defineQueue, JobError } from '@nxgt/redis';

export const mails = defineQueue({
	name: 'mails',
	schema: z.object({ to: z.string(), template: z.string() }),
	result: z.object({ messageId: z.string() }),      // optional
	attempts: 5,                                       // default 3
	backoff: { base: '1s', max: '1h' },                // exponential, full jitter
	timeout: '2m',                                     // optional
	lease: '30s',                                      // default 30 s, renewed while running
	rateLimit: { limit: 100, per: '1m' },              // optional, GCRA
	groups: { concurrency: 2 },                        // optional
	keepCompleted: { age: '1h', count: 1000 },         // default; false deletes at once
	keepFailed: '7d',                                  // default
	schedules: {
		daily: { cron: '0 7 * * *', timezone: 'Europe/Paris', data: { to: '*', template: 'digest' } },
	},
});
```

Wired, as caches and guards are:

```ts
export const redis = await openRedis(defineRedis({ uri, prefix: 'app:prod', queues: { mails } }));

const job = await redis.queues.mails.add(
	{ to, template: 'welcome' },
	{ delay: '10m', priority: 1, group: tenantId, id: `welcome/${userId}` },
);
job.id; job.deduplicated;
// one job per key, run `wait` after the last add; a reindex after edits
await redis.queues.mails.add(data, { debounce: { key: `reindex/${docId}`, wait: '30s' } });
// the first add under a key wins for `window`; at most one digest an hour
await redis.queues.mails.add(data, { throttle: { key: `digest/${userId}`, window: '1h' } });
const { messageId } = await job.finished({ timeout: '30s' });
await job.cancel();

await redis.queues.mails.addMany(families.map((f) => ({ data: { to: f.email, template: 'digest' } })));

const worker = redis.queues.mails.work(
	async ({ id, data, attempt, attempts, signal, progress }) => {
		if (cardExpired) throw new JobError('card expired', { retry: false });
		if (provider429) throw new JobError('throttled', { retryIn: '10m' });
		await progress(50);
		return { messageId };
	},
	{ concurrency: 8 },
);
worker.on('failed', ({ id, error, attempt }) => log.warn(…));
await worker.idle();
await worker.close();

const q = redis.queues.mails;
await q.counts();                      // { waiting, delayed, active, failed, completed, paused }
await q.get(id);                       // a JobView, or undefined
await q.list('failed', { offset: 0, limit: 50 });
await q.retry(id); await q.remove(id); await q.cancel(id);
await q.pause(); await q.resume();
await q.schedules.upsert('family-42', { cron: '30 18 * * *', timezone: 'Europe/Paris', data });
await q.schedules.remove('family-42'); await q.schedules.list();
```

By hand, `bindQueue(client, mails)` gives the same object without a prefix,
as `bindRateLimit` does. `defineQueue` checks and freezes its options at
import, as the other `define*` do, and throws a sentence naming the queue and
the option.

### Durations and dates

Every duration in the queue's API is a number of **milliseconds** or a string
`` `${number}${'ms' | 's' | 'm' | 'h' | 'd'}` `` checked by a template-literal
type, so `'10min'` does not compile. `add` takes `delay` or `at: Date`, never
both (a type error, and a refusal at runtime). No option of the queue is in
seconds.

### The handler

- Declared at `work()`, never in `defineQueue`: a producer imports the
  definition without the worker's dependencies.
- It receives one destructurable object: `id`, `data` (`z.output` of the
  schema), `attempt` (1-based), `attempts`, `signal`, `progress(n)` (0–100,
  written to the job hash and emitted).
- **Throwing anything retries**, after the backoff, until `attempts` is spent.
  `JobError(message, { retry: false })` sends the job straight to `failed`;
  `JobError(message, { retryIn })` sets this retry's delay. Anything else
  thrown is recorded by its message and its `name`; the stack is not stored.
- What it returns is checked by `result` when the queue has one, and kept for
  `keepCompleted`; a result the schema refuses fails the job with `INVALID`
  and no retry. A queue without `result` takes `void`.

### `signal`

An `AbortSignal` the handler may listen to. It fires when:

- `cancel(id)` reaches the job;
- `timeout` runs out — the attempt counts as failed with `TIMEOUT` whether or
  not the handler listens, and a late return is refused;
- the lease is lost (a renewal found its token gone or the lease lapsed);
- `close()`'s grace period runs out.

The worker never awaits a handler past these: it stops renewing, writes the
outcome, and frees the slot. JavaScript cannot stop the function; the signal
is the request to stop.

### The handle `add` returns

`{ id, deduplicated, finished(opts), cancel() }`. `deduplicated` is `true`
when an `id`, a debounce or a throttle kept the job from being added; the
handle then points at the job that is there (or, for a throttle, at the one
that won). `finished({ timeout })` resolves with the result (or `undefined`
for a queue without `result`), and rejects with `QueueError` `FAILED`
(carrying the last error's message), `CANCELED`, `WAIT_TIMEOUT`, or
`NOT_FOUND` when the job is gone (removed, or past its retention).
`addMany` gives an array of handles in the input's order.

## Storage

All keys of a queue share one hash tag, so a cluster keeps them on one slot:
`queue:{<name>}:<part>`, where `<name>` is the definition's name — with the
deployment's prefix in front of it when wired, as the guards' names are.

| Part | Type | Holds |
| --- | --- | --- |
| `job:<id>` | hash | `data` (JSON), `step:<name>` (JSON, slice 3), `priority`, `group`, `attempt`, `attempts`, `state`, `token`, `progress`, `error`, `result` (JSON), `added`, `runAt`, `finished`, `dedupe`, `retried` (`1` once RETRY has put the job back; only ADD's debounce reads it) |
| `delayed` | zset | id → ms at which it becomes ready |
| `ready` | zset | id → `priority × 2^40 + seq` (FIFO within a priority). On a grouped queue it stays the global index of every ready job, mirrored per group |
| `active` | zset | id → ms at which its lease lapses |
| `completed`, `failed` | zset | id → ms it finished, for retention and `list` |
| `seq` | string | the `INCR` counter behind FIFO order |
| `wake` | list | at most one token a blocked worker `BLPOP`s |
| `paused` | string | present while paused |
| `rate` | string | the GCRA state of `rateLimit` |
| `dedupe:<key>` | string | the job id holding a debounce/throttle key. A throttle's PX is its `window`; a debounce's is `wait + 24 h`, a memory bound: the state decides while the key lives, so a job left waiting longer than that can be joined by a second one; each hit refreshes it |
| `schedules` | zset | schedule id → ms of its next occurrence |
| `schedule:<id>` | hash | `cron` or `every`, `timezone`, `data` (JSON), `origin` (`definition` / `runtime`) |
| `groups:ready` | list | groups with ready jobs and a free slot, in round-robin order; each group at most once |
| `groups:queued` | set | the dedupe set of `groups:ready`: a group is pushed only when it is not in it |
| `group:<g>:ready` | zset | that group's ready jobs, scored as `ready`; the default group is `g = ''` |
| `group:<g>:active` | string | that named group's running count; the default group has none |
| `groups:mode` | string | `0` (no groups) or `1:<concurrency>` (`0` for no cap): the mode the first script to touch the queue set. Every queue writes it, grouped or not |

`priority` is a whole number from 0 (most urgent) to 1000, default 0. The
score `priority × 2^40 + seq` stays an exact double up to 2^53, so FIFO
within a priority holds for 2^40 jobs per queue.

Ids: a caller-given `id` (a string up to 256 characters, no `{` or `}`), or a
generated one (`Bun.randomUUIDv7()`, time-ordered). A scheduled occurrence's
id is `schedule:<scheduleId>:<occurrence ms>`.

A job's `data` and `result` are validated by zod **on the client** and stored
as JSON; scripts never parse them. The data is parsed again when claimed:
one the schema refuses then (the schema changed under a waiting job) goes to
`failed` with `INVALID`, without running.

## Scripts

Every transition is one Lua script run by `runScript` (EVALSHA, EVAL on
`NOSCRIPT`), timed by the server's `TIME`, so every process agrees on "now".
Each one trusts only the state it could have written, as the guards do: a
hash whose shape it does not recognise is refused, never "repaired".

- **ADD** (also the body of `addMany`, up to 500 jobs per call): for each job,
  if `job:<id>` exists → report it, add nothing. Debounce (`wait`): if
  `dedupe:<key>` names a job whose hash says `waiting` (and it is in `ready`)
  or `delayed` (and it is in `delayed`), replace its `data`, take it out of
  `ready`, put it in `delayed` at now + `wait` (keeping its priority,
  attempts and timeout), refresh the key's PX and answer with its id; a new
  head of `delayed` leaves a `wake` token. The state decides while the key lives (`wait` plus a day); a job left waiting longer can be joined by a second one. A stored key that is not a valid id is read as no key.
  If it names an active, finished or missing job, or a hash of a shape ADD
  could not have written (left untouched), add a new job and point the key at
  it: activity during a run is never lost. Throttle (`window`): if
  `dedupe:<key>` exists, answer with the id it names and add nothing, even if
  that job is gone; else add the job and set the key with `PX window`. The
  reply is per job `0` (added), `1` (the `id` existed) or the id string the
  key holds. Then write the
  hash, `ZADD delayed` (a future run time) or `ZADD ready`, and push one
  `wake` token if the list is empty (it holds at most one: "ready has work",
  or a delayed job became the head of `delayed`; each woken worker passes the
  baton, see CLAIM), but none while `paused` exists: RESUME leaves one. A
  debounce joins only a job that has not run (`attempt` 0 and no `retried`):
  a job in retry backoff, or put back by RETRY, is under way, like an active
  one, so a new job is added.
- **CLAIM**(n, lease, token; on a grouped queue also the groups' mode and cap): reclaim up to 100
  lapsed leases from `active` — each counts as an attempt (a job that kills
  its process does not loop forever): back to `ready`, or to `failed` with
  "lease lapsed" when spent; report them as `stalled`. Promote up to 1000 due
  jobs from `delayed` to `ready`; both still run while `paused`, so `counts`
  stays honest. While `paused` exists, pop nothing. Otherwise admit up to n
  under `rateLimit` (the GCRA of `defineRateLimit`, its Lua shared, not
  copied; a peek at cost 1, then the jobs popped are charged once). Pop that
  many from `ready` (on a grouped queue, round-robin over the groups, see Groups), set `state=active`, the token,
  `attempt+1`, and `ZADD active now+lease`. If `ready` still has jobs, push
  one `wake` token back if the list is empty, so a blocked peer takes over; if
  `ready` is empty (on a grouped queue: `groups:ready` is empty, see Groups), or
  the queue is paused, or the rate refuses the jobs in
  `ready`, `DEL wake` (a token there would make every worker spin on claims
  that pop nothing). That `DEL wake` may erase a delayed-head token
  pushed in the one round trip between a worker's empty claim and its `BLPOP`;
  that job then waits at most the 5 s cap (accepted). Return the jobs, the
  stalled ids, and the ms until the next wait ends: the next `delayed` job or
  schedule, `-1` when none; 5 s while paused (the worker's own cap, it only
  has to notice a lost resume token); while the rate refuses, the GCRA's
  `retryAfter` for one job when that is sooner than the delayed head.
- **RENEW**(token, ids…): for each id still holding the token, push its lease;
  return the ids that lost it (their `signal` fires). One call per worker per
  `lease / 3`, whatever its concurrency.
- **COMPLETE**(id, token, result, claim-next): if the token still holds,
  `state=completed`, store the result if any, move to `completed` (or delete
  when `keepCompleted: false`), trim `completed` by age and count (bounded per
  call), `PUBLISH` the outcome with the result, so `finished()` gets it even
  when nothing is kept. An active job's removal from `active` frees its group's
  slot. With a free slot, it then runs CLAIM's body
  for one job, so a busy worker spends **one round trip per job**.
- **FAIL**(id, token, error, retryIn, claim-next): if the token still holds and
  attempts remain and the error allows a retry → `delayed` at now + `retryIn`
  (the client computes the backoff with jitter, or takes `JobError`'s);
  else `failed`, trimmed by `keepFailed`, `PUBLISH`. Claims the next job as
  COMPLETE does, and frees the group's slot as it does.
- **CANCEL**(id): a waiting job is deleted; an active one has its token
  cleared and is deleted, and the outcome is published (its worker's `signal`
  fires; its late COMPLETE/FAIL finds no token and is dropped silently).
- **RETRY**, **REMOVE**: on a job in `failed` (RETRY resets `attempt`) or, for
  REMOVE, in any state but active (cancel it first).
- **PAUSE**, **RESUME**: set or delete `paused`; RESUME leaves one `wake`
  token when `ready` or `delayed` holds jobs, so a blocked worker starts at
  once (a delayed job may have fallen due during the pause).
- **FIRE**(scheduleId, due, next): if the schedule's score is still `due`, `due`
  is not in the future and the hash is one this package could have written,
  add the occurrence `schedule:<id>:<due>` (through the Lua of ADD, with the
  definition's `attempts` and `timeout`, priority 0) and set the score to
  `next`; else do nothing (another process fired it). A `next` that is not a
  whole number of ms above `due` is an error reply before any write. The
  occurrence is added while paused too, and waits in `ready` for RESUME.
- **DEFER**(scheduleId, due, until): for a due schedule whose spec the client
  cannot parse any more. If the score is still `due` and the hash is sound,
  set the score to `until` (the client sends now + 1 h) and add no job;
  answer 1, else 0. An `until` not above `due` is an error reply.
- **SYNC**(definitions…): make the `origin=definition` schedules equal to
  `defineQueue`'s — add, update, remove — and never touch `origin=runtime`.
  A stored score is kept when `kind`, `spec` and `timezone` are unchanged,
  so a restart pushes nothing. The ids a definition owns are the set
  `schedules:definition`, which only SYNC writes: the sweep reads that set,
  never the whole of `schedules`. A runtime schedule of a static id is taken
  over (the definition wins). At most 1 000 schedules per call, and SYNC
  refuses (error reply, before any write) while the set holds more than 2 000
  ids. `upsert` and `remove` refuse an id whose stored `origin` is
  `definition`; that is decided in the script, through the same hash.

Events cross processes over one pub/sub channel per queue,
`queue:{<name>}:events` (`completed`, `failed`, `canceled` with the id): it is
what `finished()` and an active job's cancellation listen to. Each process
opens **one** shared subscriber connection, lazily, for all its queues.

## The worker

`work(handler, { concurrency = 1 })` returns a `Worker`:
`close({ grace = '30s' })`, `idle()`, `on(event, listener)`,
`[Symbol.asyncDispose]`.

- **Waiting**: one duplicated connection per worker, blocked on
  `BLPOP wake <t>`, with `t` the next wait CLAIM reported, capped at 5 s (the
  cap is how a missed token, or a schedule another process added, is noticed).
  A wake-up claims as many jobs as the worker has free slots.
- **Leases**: renewed by RENEW every `lease / 3` for all its active jobs.
- **Schedules**: CLAIM's reply carries the schedules whose time has come, at
  most 20, earliest first, each `{id, kind, spec, timezone, due}`; so do the
  replies of COMPLETE and FAIL, so a busy worker fires too. Between the claim
  and the wait, the worker computes each one's next occurrence from the later
  of `due` and now (an outage fires the missed occurrence once, never one per
  missed tick, and the grid keeps its phase) and sends one FIRE; a spec that
  no longer parses gets a DEFER and an `error` event, and never stays due.
  CLAIM's `next` is the first schedule strictly after now, and 0 only when
  the page held 20 sound due schedules (a backlog): the worker honours that 0
  only when it sent a FIRE or DEFER that round, and waits the shortest of the
  claim's `next`, each fired schedule's new next, and the 5 s cap. Schedules
  fire while the queue is paused, at the paused 5 s cadence, and their jobs
  wait in `ready` for RESUME. Nothing fires without a worker. SYNC runs once
  per client and queue in a process, before the first claim of the first
  worker of that queue. Its failure is an `error` event and a retry, after
  1 s doubling to 30 s; jobs keep running, and the static schedules are
  updated once it succeeds.
- **`close()`** stops claiming, waits for the jobs in flight up to `grace`,
  then fires their `signal` and stops renewing — their leases lapse and they
  are reclaimed elsewhere. It closes the duplicated connection.
  `redis.close()` closes every worker still open first.
- **`idle()`** resolves when the worker has nothing running and the queue has
  nothing ready (delayed jobs excluded): a test's `await`, and a batch
  process's clean exit.
- **Events**, typed: `active`, `progress`, `completed` (with its duration),
  `retrying` (with the delay), `failed` (final), `stalled` (jobs this worker
  reclaimed), `canceled`, `error` (Redis failures; the loop backs off and
  carries on). A listener that throws is reported on `error`, never kills the
  loop.

`counts()` is one script; `list(state, { offset, limit })` pages a zset
(`waiting` lists `ready` then the groups); `get(id)` reads the hash into a
`JobView` (`state`, `data`, `attempt`, `progress`, `error`, `result`, dates).

## Running twice, and durable steps

At-least-once means a job can run again after its work was partly or wholly
done: its process died, it lost its lease, or it ran past `timeout`. Running
it **exactly once** is impossible in general — a worker can send the mail and
die before anything records that it did — so the queue shrinks that window to
the inside of one step, and gives the handler a key that lets the other side
absorb what is left. The owner asked for this (2026-10-18).

```ts
redis.queues.digest.work(async (job) => {
	const families = await job.step('load', () => loadFamilies(job.data.family));
	await job.step('send', () => mailer.send(digestOf(families), {
		idempotencyKey: job.key('send'),        // stable across attempts
	}));
});
```

- **`job.step(name, fn, { schema? })`** runs `fn` once per job, not once per
  attempt: its result (JSON-safe, checked as `data` is; parsed by `schema`
  when given) is stored in the job hash as `step:<name>`, and an attempt that
  reaches a step already stored gets the stored value back without calling
  `fn`. A name used twice in one attempt is a `TypeError`.
- **Fencing.** A step starts only after STEP_BEGIN found the attempt's token
  still holding and its lease not lapsed, and its result is stored only by
  STEP_COMMIT under the same check. An attempt that lost its lease gets
  `QueueError` `LEASE_LOST` from `step` (and its `signal` fires): a step's
  value is committed once and a stale worker never overwrites it. The fence is
  checked at the step's edges, not while `fn` runs, so `fn` itself may run
  more than once (a crash, or a lease lapsing mid-`fn`): what reaches outside
  is made idempotent with `job.key`. A step costs **two round trips**.
- **`job.key(name)`** is `<queue name>:<job id>:<name>`, the same on every
  attempt: the idempotency key to hand a provider (an `Idempotency-Key`
  header) or `redis.idempotency.*.run`, so a step run twice, or interrupted
  after its side effect but before its commit, is absorbed downstream. A queue
  name cannot hold `:`, so the key is unambiguous; it is per job id and
  outlives `remove`.
- The completion itself is token-guarded (COMPLETE), so a job is never marked
  completed twice nor its result overwritten by a late attempt; a result
  returned after `timeout` or a lost lease is refused.
- Steps survive retries and `retry(id)`: a job that failed at its third step
  resumes there. `retry(id, { fresh: true })` clears them so every step runs
  again, and `job.key` is unchanged. `remove(id)` and re-adding is the other
  way to start over.
- Code outside a step runs again on every attempt; the guide says so first,
  and puts every side effect in a step.

## Recurring jobs

A schedule is `{ cron, timezone?, data }` or `{ every, data }`. The cron
parser is written here, with no dependency: five fields, `*`, lists, ranges,
steps, month and weekday names; when both day-of-month and day-of-week are
restricted, either matches (as Vixie cron). The time zone is any IANA name
`Intl` knows (default UTC), resolved with `Intl.DateTimeFormat`. Daylight
saving: a local time that does not exist (spring forward) runs at the first
instant after the gap; one that happens twice (fall back) runs once, at the
first. A cron that can never match (`0 0 31 2 *`) is refused by
`defineQueue` and by `upsert`.

## Groups (slice 7)

`defineQueue({ groups: {} })` or `groups: { concurrency: n }` (a whole number
from 1; absent means fairness only, stored as 0) turns grouping on;
`add(data, { group })` takes a name that follows the id rule, with no `:`.
Jobs without a group form the default group, which takes its turn like the
others and has no concurrency of its own. The hash holds `group` only for a
named group.

- **`ready` stays the global index** of every ready job, so `counts`, `list`
  and the ungrouped paths do not change. Each ready job is mirrored in its
  group's zset `group:<g>:ready`, with the same score.
- **The round-robin list** `groups:ready` holds the groups that have ready
  jobs and a free slot, each once (the dedupe set `groups:queued`). A claim
  takes the head group, pops its most urgent job, and pushes the group back to
  the tail while it still has jobs and a free slot, so no group starves
  another whatever its priorities. A group at its `concurrency` leaves the list
  until a job of it leaves `active`.
- **The invariants**, after every script on a grouped queue: (1) id in `ready`
  iff in its group's zset; (2) `group:<g>:active` equals the active ids of
  that named group; (3) a group is in `groups:queued` iff it is in the list,
  once; (4) a group with ready jobs and a free slot is in `groups:queued`.
  One Lua module owns every write to them. A stale entry for a group the
  scripts could not have written is dropped by the claim, within its cap.
- **The wake rule**: "has claimable work" is `LLEN groups:ready > 0`, not
  `ZCARD ready > 0`. When every ready job sits in a full group no wake token is
  left, so workers do not spin; a script that frees a slot (COMPLETE, FAIL,
  CANCEL of an active job, a reclaim) queues the group and leaves one token.
- **`groups:mode`** is a marker every script checks first: a process whose
  definition disagrees on grouping or on `concurrency` is refused with
  `QueueError` `GROUPS_MISMATCH`, with no write, so two deploys never share a
  queue under two meanings. Every queue writes it (`0` when ungrouped). To
  change modes, drain the queue, then `DEL queue:{<name>}:groups:mode`.
- Round trips are unchanged: `add` 1, a claim 1, a busy worker 1 per job.

## Errors

`QueueError`, apart from `RedisError` and `GuardError`, naming the queue and
the job id (never the data):

| Code | When |
| --- | --- |
| `INVALID` | data the schema refuses, on `add` or at claim; a result the `result` schema refuses |
| `TIMEOUT` | an attempt ran past `timeout` (recorded as its error) |
| `LEASE_LOST` | an attempt lost its lease (recorded as its error) |
| `CANCELED` | `finished()` on a job canceled |
| `FAILED` | `finished()` on a job that failed for good |
| `WAIT_TIMEOUT` | `finished({ timeout })` gave up waiting |
| `NOT_FOUND` | `retry`, `remove`, `finished` on a job that is not there |
| `ACTIVE` | `remove` on a job that is running; cancel it first |
| `CLOSED` | `add`, `addMany`, `work` and `finished` (pending ones too) once the wiring is closed; admin calls pass through |

`JobError` is the handler's, not the library's: it is how a handler says
"don't retry" or "retry in".

## Performance

- **Round trips, pinned by specs** that count commands through a wrapped
  client: `add` 1, `addMany` 1 per 500, CLAIM of n 1, a busy worker 1 per job
  (COMPLETE/FAIL claim the next), RENEW 1 per worker per `lease / 3`.
  The 1-per-job budget holds without a `rateLimit`. Under one, a settle whose
  claim the rate refuses is followed by the worker loop's own claims while it
  waits for an admission, so a job can cost more than one round trip (not
  measured; bounded by one claim per `retryAfter`, never a spin).
  A regression is a failing spec.
- **Bounded scripts**: no script scans a whole structure; every loop has a
  cap (reclaim 100, promote 1000, trim per call), so one call cannot hold the
  server.
- **A local benchmark** (`scripts/bench-queue.ts`, not in CI): add then
  process 100 000 jobs at concurrency 1, 8 and 64; end-to-end latency p50 and
  p99 of an immediate job on an idle worker. Its numbers go in the guide with
  the machine and the versions they were measured on.

## Testing

- Every script against `startTestRedis()`, with the state each one must refuse
  written by hand (as the guards' "stored state" specs do).
- The races: two workers on one job, a lease lapsing mid-run, a cancel during
  COMPLETE, FIRE from two processes, debounce against a claim.
- The types: `@ts-expect-error` cases for a wrong payload, a duration typo,
  `delay` with `at`, a handler returning the wrong result, an unknown option.
- Mutation runs on the scripts' guards, as for the guards.

## Documentation

The README gains a Queue section and loses "It is not a queue"; a guide page
`docs/guide/queues.md` (producing, working, retries, schedules, groups,
operations, testing, the benchmark); troubleshooting entries per `QueueError`
code and per refusal of `defineQueue`; the roadmap moves *A queue* from
*Not planned* to *Now*, then to *Shipped*, and records *Next* and *Later*
above. The package's `description` and `keywords` name the queue. The
nxgt-core review reference for nxgt-data gains the queue's invariants after
the first slice.

## Slices

On the integration branch `feat/redis-queue`; each slice is a PR into it,
green and reviewed on its own; one PR into `develop` at the end, then
`@nxgt/redis` 0.9.0 (a minor: everything is added).

1. **Core** — `defineQueue`/`bindQueue`, durations, `add`/`addMany` with `id`,
   `delay`/`at`, priorities; the worker (BLPOP wake, CLAIM with reclaim and
   promotion, leases, COMPLETE/FAIL with claim-next), retries, backoff,
   `JobError`; `completed`/`failed` retention; `get`, `list`, `counts`,
   `retry`, `remove`; round-trip specs. Roadmap: *A queue* to *Now*.
2. **Lifecycle** — `result`, the handle, `finished()`, `cancel()`, `timeout`,
   `signal`, `progress`, events, `idle()`, `close({ grace })`, the shared
   subscriber.
3. **Steps** — `job.step`, `job.key`, STEP_BEGIN and STEP_COMMIT fencing,
   the "running twice" guide section.
4. **Wiring** — `queues` in `defineRedis`/`openRedis`, the prefix, names
   shared with caches and guards refused, `redis.close()` closing workers,
   `QueueError` `CLOSED`.
5. **Flow control** — debounce/throttle, `pause`/`resume`, `rateLimit`.
6. **Schedules** — the cron parser and time zones, static and runtime
   schedules, FIRE, SYNC.
7. **Groups** — per-group concurrency and round-robin.
8. **Finish** — the benchmark, the full guide and troubleshooting, the
   roadmap, an example under `examples/`.

## Decisions (owner, 2026-10-18)

Storage: sorted sets + Lua. Recurring: cron + time zone, parser written here,
plus `every`. Exhausted jobs: kept in `failed` with retention, `retry` and
`remove`. Idle wait: blocking wake on a duplicated connection. Priorities:
yes. Groups: yes, own slice. Queue rate limit: yes, through the existing GCRA.
Flows: *Next*. Results: optional and typed, with `finished()`. Cancel:
cooperative `signal`. Observability: counts + typed in-process events +
`progress`. Dedupe: `id`, debounce and throttle. `addMany`: yes. Batch
handler: *Next*. Admin: `pause`/`resume`, `get`/`list`; the rest *Later*.
Performance: round-trip budgets + local benchmark. Groups × priority:
round-robin, priority within a group. Duplicates: durable steps, a stable `job.key`, and fencing (asked after the grilling). Debounce during a run: a new job.
Completed retention: age + count, 1 h / 1000. Runtime schedules: yes, in
Redis. Timeout: signal then failure. Canceled while running: deleted, result
dropped. Rate limit per group: *Next*. Durations: ms or a typed `'10m'`, and
`at: Date`. Handler: at `work()`. Retries: throw retries, `JobError` adjusts.
Schedules removed from `defineQueue`: removed at worker start. `add` returns a
handle. Tests: `worker.idle()` on a real Redis. Start: `work()` per queue,
`close()` stops all.
