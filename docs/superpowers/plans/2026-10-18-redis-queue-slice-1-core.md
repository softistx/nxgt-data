# Queue slice 1 (core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working at-least-once queue in `@nxgt/redis`, bound by hand: `defineQueue`, `bindQueue`, `add`/`addMany` (id dedupe, delay/at, priority), a worker with leases, retries and backoff, retention, and inspection.

**Architecture:** Every transition is one Lua script (`defineScript`/`runScript`) over the keys `queue:{<name>}:*`, timed by the server's `TIME`. The worker claims in batches, renews all its leases in one call, settles a job and claims the next in the same script, and waits on `BLPOP` of a duplicated connection.

**Tech Stack:** Bun 1.4.3 `RedisClient`, Lua (Redis 7.4), zod 4, `bun:test`, `startTestRedis` fixtures.

**Spec:** `docs/superpowers/specs/2026-10-18-redis-queue-design.md` (sections Shape of the API, Storage, Scripts, The worker, Errors, Performance; slice 1 only).

## Global Constraints

- Code lives in `packages/redis/src/queue/`; errors in `packages/redis/src/errors/`. Imports without `.js`/`.ts` extensions.
- Bun only; no new dependency, no new peer.
- Every duration: a number of ms or `` `${number}${'ms'|'s'|'m'|'h'|'d'}` ``; nothing in seconds.
- Defaults: `attempts` 3, `backoff` `{ base: 1_000, max: 3_600_000 }` (full jitter), `lease` 30 000 ms, `keepCompleted` `{ age: 3_600_000, count: 1000 }`, `keepFailed` 604 800 000 ms.
- `priority`: whole number 0–1000, default 0; `ready` score = `priority × 2^40 + seq`.
- Ids: 1–256 characters, no `{` or `}`; generated ones `Bun.randomUUIDv7()`.
- Keys: `queue:{<name>}:<part>`; parts `job:<id>`, `delayed`, `ready`, `active`, `completed`, `failed`, `seq`, `wake`.
- Script caps: reclaim 100, promote 1000, trim 100 per call; `addMany` 500 jobs per script; `wake` trimmed to 1000; BLPOP wait capped at 5 000 ms.
- Errors name the queue and the job id, never the data. `defineQueue` refusals are bare `TypeError`s that quote the option, as `defineIdempotency`'s do.
- Round trips: `add` 1 script, `addMany` 1 per 500, CLAIM of n 1, a busy worker 1 per job.
- Match the surrounding code: TSDoc on every export, comments that say why, tabs, the `call`-named refusals of `define-idempotency.ts`.

## Review Focus

- A payload that is not JSON-safe (`Date`, `bigint`, `undefined` fields, a transform): refused on `add` with `INVALID` after a JSON parse-back, never stored half-right. → Task 3.
- A worker whose process dies mid-job: the job comes back after the lease, counted as an attempt, and lands in `failed` with "lease lapsed" when spent. → Task 4.
- A handler that throws a non-`Error` (a string, `undefined`): retried, and recorded with a readable message. → Task 5.
- `close()` while jobs run and while the loop is blocked on `BLPOP`: resolves after the jobs settle, does not wait 5 s, and closes the duplicated connection. → Task 5.
- A stored job hash this package could not have written (fields missing, a non-numeric `attempt`): CLAIM fails it with `INVALID` instead of running or crashing the script. → Task 4.

---

### Task 1: Durations and errors

**Files:**
- Create: `packages/redis/src/queue/duration.ts`
- Create: `packages/redis/src/errors/queue-error.ts`, `packages/redis/src/errors/job-error.ts`
- Test: `packages/redis/src/queue/duration.spec.ts`, `packages/redis/src/errors/queue-error.spec.ts`

**Interfaces:**
- Produces: `type Duration = number | \`${number}${'ms'|'s'|'m'|'h'|'d'}\``; `toMs(value: Duration, what: string): number` (throws `TypeError` `` `${what} is ${JSON.stringify(value)}; a duration is a whole number of milliseconds or a string such as '10m'` `` for a negative, fractional, non-finite or malformed value).
- Produces: `type QueueErrorCode = 'INVALID' | 'NOT_FOUND' | 'ACTIVE'` (slice 2 adds the rest); `class QueueError extends Error { readonly code; readonly queue: string; readonly job?: string }`, `name = 'QueueError'`.
- Produces: `class JobError extends Error` with `constructor(message: string, options?: { retry: false } | { retryIn: Duration })`; readonly `retry: boolean`, `retryIn?: number` (ms, via `toMs`).

- [ ] **Step 1: Write the failing tests**

```ts
test('a number is milliseconds, a string has a unit', () => {
	expect(toMs(250, 'delay')).toBe(250);
	expect(toMs('1.5s', 'delay')).toBe(1500);
	expect(toMs('10m', 'delay')).toBe(600_000);
	expect(toMs('2h', 'delay')).toBe(7_200_000);
	expect(toMs('7d', 'keepFailed')).toBe(604_800_000);
});
test.each([-1, 1.5, Number.NaN, '10min', '', 'm', '-5s'])('%p is refused, naming the option', (v) => {
	expect(() => toMs(v as never, 'delay')).toThrow(/^delay is .*; a duration is a whole number of milliseconds/);
});
test('JobError carries retry and retryIn', () => {
	expect(new JobError('x').retry).toBe(true);
	expect(new JobError('x', { retry: false }).retry).toBe(false);
	expect(new JobError('x', { retryIn: '10m' }).retryIn).toBe(600_000);
});
test('QueueError names the queue and the job, and is a QueueError by name', () => {
	const e = new QueueError('NOT_FOUND', 'mails', 'retry on "mails": no failed job j1', 'j1');
	expect([e.code, e.queue, e.job, e.name]).toEqual(['NOT_FOUND', 'mails', 'j1', 'QueueError']);
});
```

`'1.5s'` gives 1500 because the result is whole; `'1.5ms'` is refused.

- [ ] **Step 2: Run them, see them fail** — `cd packages/redis && bun test src/queue/duration.spec.ts src/errors/queue-error.spec.ts` → FAIL, modules not found.
- [ ] **Step 3: Implement** — `QueueError`'s constructor is `(code, queue, message, job?)`, documented like `GuardError` (each code's TSDoc says when it happens).
- [ ] **Step 4: Run them, see them pass.**
- [ ] **Step 5: Commit** — `feat(redis): Durations, QueueError and JobError for the queue`.

---

### Task 2: `defineQueue`, the types and the keys

**Files:**
- Create: `packages/redis/src/queue/types.ts`, `packages/redis/src/queue/define-queue.ts`, `packages/redis/src/queue/keys.ts`
- Modify: `packages/redis/test/fixtures.ts` (add `mailQueue`)
- Test: `packages/redis/src/queue/define-queue.spec.ts`

**Interfaces:**
- Consumes: `Duration`, `toMs` (Task 1).
- Produces, in `types.ts`:
  - `QueueInput<S extends z.ZodType>` = `{ name: string; schema: S; attempts?: number; backoff?: { base?: Duration; max?: Duration }; lease?: Duration; keepCompleted?: false | { age?: Duration; count?: number }; keepFailed?: Duration }`.
  - `QueueDefinition<S>` = frozen, every option resolved to ms: `{ name; schema; attempts: number; backoff: { base: number; max: number }; lease: number; keepCompleted: false | { age: number; count: number }; keepFailed: number }`.
  - `AddOptions` = `{ id?: string; priority?: number } & ({ delay?: Duration; at?: never } | { at?: Date; delay?: never })`.
  - `JobHandle` = `{ readonly id: string; readonly deduplicated: boolean }` (slice 2 adds `finished`, `cancel`).
  - `JobContext<S>` = `{ id: string; data: z.output<S>; attempt: number; attempts: number }`.
  - `JobState` = `'waiting' | 'delayed' | 'active' | 'completed' | 'failed'`.
  - `JobView<S>` = `{ id; state: JobState; data: z.output<S> | undefined; attempt; attempts; priority; error?: { name: string; message: string }; added: Date; runAt: Date; finished?: Date }` (`data` is `undefined` when the stored data no longer parses).
  - `QueueCounts` = `Record<JobState, number>`.
  - `WorkOptions` = `{ concurrency?: number }` (default 1, whole, 1–1000).
  - `Worker` = `{ close(): Promise<void>; on(event: 'error', listener: (error: unknown) => void): () => void; [Symbol.asyncDispose](): Promise<void> }`.
  - `BoundQueue<S>` = `{ readonly definition: QueueDefinition<S>; add; addMany; work; get; list; counts; retry; remove }` with the signatures of Tasks 3, 5 and 6.
- Produces: `defineQueue<S extends z.ZodType>(input: QueueInput<S>): QueueDefinition<S>`, `checkQueue(input, call: string): void` (for `bindQueue`, as `checkIdempotency`).
- Produces: `queueKeys(name: string)` → `{ job(id: string): string; prefix: string; delayed; ready; active; completed; failed; seq; wake }` where `prefix` is `queue:{<name>}:job:`.

- [ ] **Step 1: Write the failing tests**

```ts
test('fills the defaults, in milliseconds, and freezes', () => {
	const q = defineQueue({ name: 'mails', schema: z.object({ to: z.string() }) });
	expect(q).toMatchObject({ attempts: 3, backoff: { base: 1_000, max: 3_600_000 }, lease: 30_000,
		keepCompleted: { age: 3_600_000, count: 1000 }, keepFailed: 604_800_000 });
	expect(Object.isFrozen(q)).toBe(true);
});
test('takes durations as strings', () => {
	const q = defineQueue({ name: 'm', schema: z.string(), lease: '1m', backoff: { base: '2s' }, keepFailed: '1d' });
	expect([q.lease, q.backoff.base, q.backoff.max, q.keepFailed]).toEqual([60_000, 2_000, 3_600_000, 86_400_000]);
});
test.each([
	[{ name: '' }, /^defineQueue: a queue needs a name/],
	[{ name: 'a{b' }, /^defineQueue: "a\{b" .* braces/],
	[{ attempts: 0 }, /^defineQueue: "mails" has attempts of 0; .* at least 1/],
	[{ backoff: { base: '1h', max: '1s' } }, /^defineQueue: "mails" has a backoff base of 3600000ms above its max of 1000ms/],
	[{ lease: 999 }, /^defineQueue: "mails" has a lease of 999ms; .* at least 1000/],
	[{ keepCompleted: { count: -1 } }, /keepCompleted count/],
	[{ schema: undefined }, /has no schema/],
])('refuses %p', (patch, message) => {
	expect(() => defineQueue({ name: 'mails', schema: z.string(), ...patch } as never)).toThrow(message);
});
test('keys share one hash tag', () => {
	const k = queueKeys('app:prod:mails');
	expect(k.ready).toBe('queue:{app:prod:mails}:ready');
	expect(k.job('j1')).toBe('queue:{app:prod:mails}:job:j1');
});
```

- [ ] **Step 2: Run, see it fail.**
- [ ] **Step 3: Implement** — a lease below 1 000 ms is refused because it is renewed every third of it. Add to `test/fixtures.ts`: `export const mailQueue = defineQueue({ name: 'mails', schema: z.object({ to: z.string(), template: z.string().default('welcome') }), lease: 300, backoff: { base: 10, max: 50 } })`.
- [ ] **Step 4: Run, see it pass.**
- [ ] **Step 5: Commit** — `feat(redis): defineQueue`.

---

### Task 3: ADD, `add` and `addMany`

**Files:**
- Create: `packages/redis/src/queue/scripts/add.ts`, `packages/redis/src/queue/bind-queue.ts`, `packages/redis/src/queue/encode.ts`
- Test: `packages/redis/src/queue/add.spec.ts`

**Interfaces:**
- Consumes: Tasks 1–2; `defineScript`, `runScript` from `../scripts/run-script`.
- Produces: `encodeData(definition, data: unknown, call: string): string` (safeParse, `JSON.stringify` the output, parse the JSON back through the schema; any failure → `QueueError('INVALID', name, "<call> on \"<name>\": the data does not match the schema")`, the zod issues as `cause`); `decodeData(definition, json: string): { ok: true; data } | { ok: false }`.
- Produces: `bindQueue<S>(client: RedisClient, definition: QueueDefinition<S>): BoundQueue<S>` with `add(data: z.input<S>, options?: AddOptions): Promise<JobHandle>` and `addMany(items: readonly { data: z.input<S>; options?: AddOptions }[]): Promise<JobHandle[]>` (input order kept).
- Produces: `ADD` script. KEYS: delayed, ready, seq, wake. ARGV: job-key prefix, then per job `id, data, priority, attempts, delayMs, atMs` (`atMs` `-1` when absent; a past `at` is ready now). Returns per job `0` (added) or `1` (existed). Hash written: `data, priority, attempt=0, attempts, state, added, runAt` (ms from `TIME`). Ready → `ZADD ready priority*2^40+INCR(seq)`, `LPUSH wake 1`; then `LTRIM wake 0 999` once.

- [ ] **Step 1: Write the failing tests** (in `add.spec.ts`, with `useRedis()`):
  - `'add stores the parsed output and returns a generated id'` — `template` defaulted in the stored `data`; `id` matches the UUIDv7 regex; `deduplicated` false; `state` `waiting`; `ZSCORE ready id` is `0 * 2**40 + 1`.
  - `'an id already there is not added again'` — second `add(…, { id: 'j1' })` → `deduplicated: true`, `HGET data` still the first payload.
  - `'delay and at put the job in delayed, scored by the server clock'` — `ZSCORE delayed` within `[TIME + 59_000, TIME + 61_000]` for `delay: '1m'`; `at: new Date(Date.now() - 1000)` lands in `ready`.
  - `'priority orders ready, FIFO within a priority'` — adds p5, p0, p5 → `ZRANGE ready 0 -1` is `[p0, p5a, p5b]`.
  - `'refuses with INVALID, naming the queue, never the data'` — `{ to: 5 }`, and `{ to: 'a', at: new Date('nope') }` (TypeError), `priority: 1001`, `id: 'a}b'`, `delay` with `at` (TypeError at runtime too): no key written (`DBSIZE` 0); the INVALID message contains `"mails"` and not the payload.
  - `'a payload that is not JSON-safe is refused'` — schema `z.object({ at: z.date() })` with a `Date` → `INVALID` (the parse-back fails).
  - `'addMany keeps order, dedupes within the batch, and spends one script per 500'` — 1 200 jobs with ids `j0…j1199` plus a repeat of `j3` → 1 201 handles, the repeat `deduplicated`; the script count from `INFO commandstats` (copy `scriptCalls` from `idempotency/lease/heartbeat.spec.ts` into `test/fixtures.ts` and import it there too) rises by exactly 3.
  - `'add spends one script'` — the count rises by 1.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** — `bindQueue` checks the definition with `checkQueue(definition, 'bindQueue')`, encodes every item before any script runs (a bad item in `addMany` refuses the whole call, nothing written), then chunks by 500.
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit** — `feat(redis): Add jobs to a queue`.

---

### Task 4: CLAIM, COMPLETE, FAIL and RENEW

**Files:**
- Create: `packages/redis/src/queue/scripts/claim.ts` (`CLAIM_FN` Lua snippet + `CLAIM`), `packages/redis/src/queue/scripts/settle.ts` (`COMPLETE`, `FAIL`), `packages/redis/src/queue/scripts/renew.ts`, `packages/redis/src/queue/scripts/replies.ts` (typed parsing of the replies)
- Test: `packages/redis/src/queue/scripts/claim.spec.ts`, `settle.spec.ts`, `stored-state.spec.ts`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces: `CLAIM_FN` — one Lua `local function claim(n, lease, token, now)` included verbatim in the sources of `CLAIM`, `COMPLETE` and `FAIL` (string concatenation, so one body exists). In order: reclaim up to 100 `active` with score `< now` (attempt already counted at claim; `attempt < attempts` → back to `ready` with its priority score; else `failed`, `error` = `{"name":"LeaseLapsed","message":"lease lapsed"}`); promote up to 1000 due `delayed` to `ready`; pop up to `n` from `ready` (`ZPOPMIN`), for each check the hash (fields `data`, `attempt`, `attempts`, `priority` present, numbers numeric; else → `failed` with `{"name":"QueueError","message":"INVALID: a stored job this package could not have written"}`), set `state=active`, `token`, `attempt+1`, `ZADD active now+lease`; if `ready` is not empty, `LPUSH wake 1`; compute `next` = ms until the first `delayed` score, or `-1`.
- Produces: `claim(client, keys, n, lease): Promise<ClaimReply>` with `ClaimReply = { jobs: { id: string; data: string; attempt: number; attempts: number; token: string }[]; stalled: string[]; failedInvalid: string[]; next: number }`. The token is 32 lowercase hex, one per claimed job (made client-side, `n` of them in ARGV).
- Produces: `complete(client, keys, definition, id, token, claimNext: boolean): Promise<ClaimReply & { settled: boolean }>` — token mismatch → `settled: false`, nothing changed. Settled: `state=completed`, `finished`, `HDEL token`, `ZREM active`, `ZADD completed now`, trim `completed` by age then count (≤100 removed, hashes deleted); `keepCompleted: false` deletes the hash at once.
- Produces: `fail(client, keys, definition, id, token, error: { name: string; message: string }, retryInMs: number | null, claimNext: boolean): Promise<ClaimReply & { settled: boolean; final: boolean }>` — `retryInMs` `null` means no retry. Retry when `retryInMs !== null && attempt < attempts`: `state=delayed`, `ZADD delayed now+retryInMs`, `error` kept. Else `state=failed`, `ZADD failed now`, trim `failed` by `keepFailed` age (≤100).
- Produces: `renew(client, keys, lease, entries: { id: string; token: string }[]): Promise<string[]>` — the ids whose token no longer holds; the others get `ZADD active XX now+lease`.

- [ ] **Step 1: Write the failing tests** — script-level, writing state by hand where the spec says "trusts only what it wrote":
  - claim: `'claims by priority, sets active with a lease from the server clock'`; `'claims at most n, and pushes a wake token when ready is left non-empty'` (`LLEN wake` 1 after claiming 2 of 3, 0 after claiming the last); `'promotes due delayed jobs, and reports the ms to the next one'`; `'reclaims a lapsed lease as an attempt'` (set `ZADD active 1 id` by hand, attempt 1 of 3 → back in `ready`, in `stalled`); `'a lapsed lease on the last attempt fails with "lease lapsed"'`.
  - stored-state: `'a hash missing data or with a non-numeric attempt is failed with INVALID, not run'`; `'an id in ready with no hash is dropped'` (ZREM, not in any reply).
  - settle: `'complete with the wrong token changes nothing'`; `'complete keeps the job in completed, trimmed by count'` (definition with `keepCompleted: { count: 2 }`, complete 3 → oldest hash deleted, `ZCARD completed` 2); `'keepCompleted false deletes at once'`; `'fail retries into delayed while attempts remain, then fails for good'`; `'fail with retryInMs null fails at once'`; `'complete with claimNext returns the next job in the same script'` (script count +1 for settle-and-claim).
  - renew: `'renews only the entries whose token holds, and returns the lost ones'`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** — every Lua loop has its cap; scripts touch job hashes by `prefix .. id` (same hash tag, so one slot). Comment the trust rule above `CLAIM_FN` as `idempotency/scripts.ts` does.
- [ ] **Step 4: Run, see them pass.** Then run a mutation pass with the repository's mutation script (memory: `mutation-script.md`) over the guards in `CLAIM_FN` (token check, attempt comparison, cap) and record the survivors in the PR.
- [ ] **Step 5: Commit** — `feat(redis): Claim, settle and renew queue jobs atomically`.

---

### Task 5: The worker

**Files:**
- Create: `packages/redis/src/queue/worker/worker.ts`, `packages/redis/src/queue/worker/leases.ts`, `packages/redis/src/queue/backoff.ts`
- Modify: `packages/redis/src/queue/bind-queue.ts` (add `work`)
- Test: `packages/redis/src/queue/worker/worker.spec.ts`, `leases.spec.ts`, `packages/redis/src/queue/backoff.spec.ts`

**Interfaces:**
- Consumes: Task 4's `claim`, `complete`, `fail`, `renew`; `decodeData` (Task 3).
- Produces: `backoffDelay(attempt: number, backoff: { base: number; max: number }, random = Math.random): number` = `Math.floor(random() * Math.min(max, base * 2 ** (attempt - 1)))` (full jitter).
- Produces: `startWorker<S>(client, definition, keys, handler: (job: JobContext<S>) => unknown, options: WorkOptions): Worker` and `BoundQueue.work(handler, options?)` calling it.
- Produces: `keepLeases(client, keys, lease, onLost: (ids: string[]) => void): { add(id, token): void; delete(id): void; stop(): void }` — one RENEW per `lease / 3` for every entry; a renewal that does not reach Redis is retried at the next beat; each promise gets both handlers where it is made (Bun ends the process on an unhandled rejection).

Loop, in `worker.ts`: opens `await client.duplicate()` for waiting; while open: claim as many as free slots; run each job in its slot (`decodeData` failing → `fail` with `retryInMs: null` and `INVALID`); on return → `complete(…, claimNext = free slot && open)`; on throw → `fail` with `JobError.retry === false ? null : (JobError.retryIn ?? backoffDelay(attempt, backoff))`, the error as `{ name, message }` (`String(thrown)` and name `'Error'` for a non-`Error`); a job returned by claim-next starts in the same slot. With no job claimed: `BLPOP wake min(next >= 0 ? next : 5000, 5000) / 1000` on the duplicate. A Redis failure is emitted on `'error'` and the loop waits 1 s, doubling to 30 s, reset by a success. A lost lease: forget the job (its late settle is dropped by the token check).

`close()`: stops claiming, closes the duplicate (this ends a pending `BLPOP` at once), awaits every running handler and its settle, stops the leases; idempotent; `[Symbol.asyncDispose]` calls it.

- [ ] **Step 1: Write the failing tests** (handlers record calls; `eventually` from fixtures waits):
  - `'runs an added job once and completes it'` — `counts()` later; here `HGET state` `completed`.
  - `'a job added while the worker waits is picked up at once'` — worker started on an empty queue; add; handler called within 200 ms (proves BLPOP, not the 5 s cap).
  - `'a delayed job runs when due, not before'` — `delay: 300` → not called at 150 ms, called by 1 000 ms.
  - `'a throw retries with backoff, then fails for good after attempts'` — `attempts: 3`, always throws → handler called 3 times, `state` `failed`, `error.message` the last one's.
  - `'JobError retry false fails at once; retryIn sets the delay'` — 1 call; `ZSCORE delayed` ≈ now + 600 000.
  - `'a thrown string is recorded readably'` — `throw 'nope'` → error `{ name: 'Error', message: 'nope' }`.
  - `'concurrency runs that many at once, never more'` — 10 jobs, concurrency 3, a gate: max simultaneous = 3.
  - `'a busy worker spends one script per job'` — 50 jobs, concurrency 1: scripts ≤ 50 + a small constant (assert ≤ 55), measured after the first claim.
  - `'a job whose process died is reclaimed after its lease'` — the dead process is a bare `claim(client, keys, 1, definition.lease)` that is never renewed nor settled; after the 300 ms lease a worker starts, runs the job once, and the job's `attempt` is 2.
  - `'close waits for running jobs, then resolves without the 5 s wait, and closes its connection'` — close during a 200 ms handler: resolves in 200–1 000 ms; the job completed.
  - `'a Redis failure is emitted on error and the loop carries on'` — from another client, `client.send('CLIENT', ['KILL', 'TYPE', 'normal'])` while the worker waits; then add a job → it is handled (Bun reconnects), and the `error` listener got at least one call.
  - leases: `'renews every third of the lease in one script for all jobs'`; `'reports the ids whose token was taken'`.
  - backoff: `'doubles up to max, with full jitter'` (random = () => 0.999…, attempts 1..10, base 10, max 50 → 9, 19, 39, 49, 49…; random = () => 0 → 0).
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** as described above.
- [ ] **Step 4: Run, see them pass**, then run the worker specs 20 times in a row (`for i in $(seq 20); do bun test src/queue/worker || break; done`) — a flake is fixed here, not later.
- [ ] **Step 5: Commit** — `feat(redis): Work a queue`.

---

### Task 6: Inspection and repair

**Files:**
- Create: `packages/redis/src/queue/scripts/admin.ts` (`COUNTS`, `RETRY`, `REMOVE`), `packages/redis/src/queue/inspect.ts`
- Modify: `packages/redis/src/queue/bind-queue.ts`
- Test: `packages/redis/src/queue/inspect.spec.ts`

**Interfaces:**
- Produces on `BoundQueue<S>`: `get(id): Promise<JobView<S> | undefined>`; `list(state: JobState, page?: { offset?: number; limit?: number }): Promise<JobView<S>[]>` (limit default 50, max 1000, else `TypeError`; `waiting`/`delayed`/`active` oldest first, `completed`/`failed` newest first; ids whose hash is gone are skipped); `counts(): Promise<QueueCounts>` (one script); `retry(id): Promise<void>` (failed → `ready`, `attempt=0`, `HDEL error`, wake; not in `failed` → `QueueError` `NOT_FOUND`); `remove(id): Promise<void>` (any state but active, removed from its zset and deleted; active → `QueueError` `ACTIVE`; absent → `NOT_FOUND`).
- `list` reads hashes with one `HGETALL` per id issued together (Bun pipelines concurrent commands), never one round trip each in sequence.

- [ ] **Step 1: Write the failing tests** — `'counts every state in one script'`; `'get maps the hash, with data parsed and dates as Date'`; `'get gives data undefined when the stored data no longer parses'`; `'list pages each state in its order and skips vanished hashes'`; `'retry puts a failed job back with its attempts reset, and a worker runs it'`; `'retry of a job not failed is NOT_FOUND'`; `'remove deletes a waiting, delayed, completed or failed job; refuses an active one with ACTIVE'`; `'limit above 1000 is refused'`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit** — `feat(redis): Inspect and repair a queue`.

---

### Task 7: Types, exports, docs, changeset

**Files:**
- Create: `packages/redis/test/types/queue.ts`, `.changeset/redis-queue-core.md`, `packages/redis/docs/guide/queues.md`
- Modify: `packages/redis/src/index.ts`, `packages/redis/README.md`, `packages/redis/docs/troubleshooting.md`, `packages/redis/docs/roadmap.md`, `packages/redis/package.json` (`description`, `keywords` + `queue`, `jobs`), `docs/superpowers/specs/2026-10-18-redis-queue-design.md` (add `ACTIVE` to the Errors table: "`remove` on a job that is running; cancel it first")

**Interfaces:**
- Exports from the root: `defineQueue`, `bindQueue`, `QueueError`, `JobError`; types `QueueInput`, `QueueDefinition`, `BoundQueue`, `AddOptions`, `JobHandle`, `JobContext`, `JobState`, `JobView`, `QueueCounts`, `WorkOptions`, `Worker`, `Duration`, `QueueErrorCode`.

- [ ] **Step 1: Write the type cases** in `test/types/queue.ts`, each a `@ts-expect-error` that must stay an error: a payload of the wrong shape to `add`; `delay: '10min'`; `delay` with `at`; `priority: '1'`; a handler reading `job.data.nope`; `defineQueue` with an unknown option; and positive cases: `add` without a defaulted field, `job.data.template` is `string` in the handler.
- [ ] **Step 2: Run `bun run typecheck` at the root** — PASS (each `@ts-expect-error` is used).
- [ ] **Step 3: Export** from `src/index.ts`, in the file's alphabetical order of modules.
- [ ] **Step 4: Docs** — dispatch `nxgt-docs:documentation-writer` (model sonnet) for: a README "Queue" section (a producer and a worker, bound by hand; "It is not a queue" reworded to say pub/sub is not one, the queue is), `docs/guide/queues.md` (adding, delays, priorities, the worker, retries and `JobError`, retention, inspection — only what this slice ships; the wiring and the later features are the roadmap's, not the guide's), one troubleshooting entry per refusal of `defineQueue` and per `QueueError` code, with the exact message as heading. Dispatch `nxgt-docs:roadmap-keeper`: *A queue* leaves *Not planned* for *Now* (what slice 1 gives, and what the effort still brings); *Next*: flows, batch handler, rate limit per group; *Later*: `promote`/`changeDelay`/`changePriority`, `drain`/`obliterate`.
- [ ] **Step 5: Changeset** — `'@nxgt/redis': minor`, "A queue: `defineQueue` and `bindQueue` — jobs typed by a schema, delays, priorities, at-least-once workers with leases, retries with backoff, retention and inspection."
- [ ] **Step 6: Green bar** — at the root: `bun run check && bun run typecheck && bun run build && bun run test && bun run verify:artifacts` → all pass.
- [ ] **Step 7: Commit** — `feat(redis): Export the queue, and document it`.

---

## After the tasks

- [ ] `nxgt-review:review-before-a-pr` on the slice branch (code-reviewer, model opus) until `ready: true`; `nxgt-docs:documentation-auditor` until `ok: true`.
- [ ] PR from `feat/redis-queue-core` into `feat/redis-queue`, naming the four merge conditions and the mutation survivors; merge once green.
- [ ] nxgt-core: the review reference `references/nxgt-data.md` gains the queue's invariants (hash shapes, token-guarded settle, caps, claim-next) in its own PR there.
