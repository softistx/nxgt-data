# Queue slice 2 (lifecycle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A job's whole life, seen from both sides: an optional typed `result`, a handle whose `finished()` waits for the outcome and whose `cancel()` stops it, a per-job `timeout`, an `AbortSignal` and `progress()` in the handler, typed worker events, `worker.idle()`, and `close({ grace })`.

**Architecture:** Outcomes cross processes over one pub/sub channel per queue, `queue:{<name>}:events`, published by the settling scripts; each process listens through one shared, reference-counted subscriber connection per client. The worker keeps one `AbortController` per running job and aborts it from four sources (cancel, timeout, lost lease, close grace); it never awaits a handler past an abort.

**Tech Stack:** Bun 1.4.3 `RedisClient` (pub/sub on a `duplicate()`), Lua (Redis 7.4), zod 4, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-18-redis-queue-design.md` — sections The handler, `signal`, The handle `add` returns, Scripts (COMPLETE, FAIL, CANCEL), The worker, Errors. Slice 1's code is on `feat/redis-queue`; its deferred findings are in `.superpowers/sdd/slice-1-ledger.md` of the integration worktree.

## Global Constraints

- Everything from slice 1's Global Constraints still binds (durations, key layout, caps, no data in messages, round-trip budgets, TSDoc, no import extensions).
- A `QueueError` message names the call, the queue and the job id, never data nor a handler's error text; a handler's last error travels in a separate `lastError: { name, message }` field.
- Event channel: `queue:{<name>}:events`; message JSON `{ "type": "completed" | "failed" | "canceled", "id": string, "result"?: <JSON>, "error"?: { name, message } }`. Published only on a final outcome (COMPLETE settled, FAIL final, CANCEL of a job that existed) — never on a retry.
- One subscriber connection per `RedisClient` per process, shared by every queue bound to it, opened on first listen and closed when the last listener leaves.
- `progress`: a number from 0 to 100 (finite); anything else is a `TypeError` naming the queue.
- `close({ grace })`: default `grace` 30 000 ms; `close()` resolves within `grace` + one round trip even when a handler ignores its signal.
- New `QueueErrorCode`s: `CANCELED`, `FAILED`, `WAIT_TIMEOUT`, `TIMEOUT`, `LEASE_LOST`, `CLOSED`. `TIMEOUT` and `LEASE_LOST` are also the `name` recorded in a job's `error` when an attempt ends that way.
- `cancel` resolves `true` when it canceled a waiting, delayed or running job, `false` when there was nothing to cancel (finished, removed or unknown).
- `finished()` has no deadline unless `timeout` is given.
- A slot is freed as soon as its job is aborted; the late handler keeps running unawaited, and its return is dropped by the token check.
- Commit prefixes from AGENTS.md's list (`feat`, `fix`, `chore` for refactors, `docs`…); messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- `finished()` called after the job already completed, failed or was canceled: it resolves or rejects from the stored state, never hangs. → Task 4.
- `finished()` on a job past its retention or removed: `NOT_FOUND`, never a hang. → Task 4.
- A handler that ignores its signal after `timeout`: the slot frees, the attempt is recorded as `TIMEOUT` exactly once, the late return produces no second settle. → Task 6.
- `cancel` racing a COMPLETE: exactly one outcome is published, and `finished()` sees that one. → Task 2 (script) and Task 4 (handle).
- `close({ grace })` while a handler ignores its signal: `close` resolves after `grace`, the job's lease lapses and another worker reclaims it. → Task 6.

---

### Task 1: Types, options and error codes

**Files:**
- Modify: `packages/redis/src/queue/types.ts`, `packages/redis/src/queue/define-queue.ts`, `packages/redis/src/errors/queue-error.ts`
- Test: `packages/redis/src/queue/define-queue.spec.ts`, `packages/redis/test/types/queue.ts`

**Interfaces:**
- Produces: `QueueInput<S, R extends z.ZodType | undefined = undefined>` gains `result?: R` and `timeout?: Duration`; `QueueDefinition<S, R>` gains `readonly result: R` and `readonly timeout: number | undefined`. `defineQueue<S, R = undefined>(input): QueueDefinition<S, R>`.
- Produces: `ResultOf<R>` = `R extends z.ZodType ? z.output<R> : undefined`; `ResultInputOf<R>` = `R extends z.ZodType ? z.input<R> : void`.
- Produces: `AddOptions` gains `timeout?: Duration`.
- Produces: `JobContext<S>` gains `signal: AbortSignal` and `progress(value: number): Promise<void>`. `Handler<S, R>` = `(job: JobContext<S>) => ResultInputOf<R> | Promise<ResultInputOf<R>>`.
- Produces: `JobHandle<R>` = `{ readonly id; readonly deduplicated; finished(options?: { timeout?: Duration }): Promise<ResultOf<R>>; cancel(): Promise<boolean> }`.
- Produces: `JobView<S, R>` gains `progress: number` and `result?: ResultOf<R>`.
- Produces: `WorkerEvents` = `{ active: { id; attempt }; progress: { id; progress }; completed: { id; attempt; duration: number }; retrying: { id; attempt; delay: number; error: { name; message } }; failed: { id; attempt; error: { name; message } }; stalled: { id }; canceled: { id }; error: unknown }`. `Worker.on<E extends keyof WorkerEvents>(event: E, listener: (payload: WorkerEvents[E]) => void): () => void`; `Worker.idle(): Promise<void>`; `Worker.close(options?: { grace?: Duration }): Promise<void>`.
- Produces: `WorkOptions` unchanged (grace belongs to `close`).
- Produces: `BoundQueue<S, R>` — every method retyped with `R`; `work(handler: Handler<S, R>, options?)`; `add`/`addMany` return `JobHandle<R>`; new `cancel(id: string): Promise<boolean>`.
- Produces: `QueueError` gains `readonly lastError?: { name: string; message: string }` (set only for `FAILED`), constructor `(code, queue, message, job?, lastError?)`.

- [ ] **Step 1: Write the failing tests** — define-queue.spec: `result` kept as given, `timeout: '2m'` → 120 000, `timeout` absent → `undefined`, `result: 5` refused (`/has a result that is not a schema/`), `timeout: 0` refused. test/types/queue.ts: a handler of a queue with `result: z.object({ id: z.string() })` returning `{ id: 1 }` is an error; returning nothing is an error; a queue without `result` whose handler returns `{ id: 'x' }` is an error; `(await handle.finished()).id` is `string`; `finished()` of a queue without `result` is `undefined`; `worker.on('completed', (e) => e.nope)` is an error; `worker.on('nope', …)` is an error; `job.progress('50')` is an error.
- [ ] **Step 2: Run, see them fail** — `bun test src/queue/define-queue.spec.ts` and root `bun run typecheck`.
- [ ] **Step 3: Implement** — types only plus the two options; keep `bindQueue`/worker compiling with temporary `R` defaults; no runtime behaviour beyond `defineQueue`.
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit** — `feat(redis): Type a queue's result, timeout, handle and events`.

---

### Task 2: Scripts — timeout field, result, outcomes published, CANCEL, PROGRESS

**Files:**
- Modify: `packages/redis/src/queue/scripts/add.ts`, `claim.ts`, `replies.ts`, `settle.ts`, `packages/redis/src/queue/keys.ts` (add `events`)
- Create: `packages/redis/src/queue/scripts/cancel.ts`, `packages/redis/src/queue/scripts/progress.ts`
- Test: `packages/redis/src/queue/scripts/*.spec.ts` (extend), `cancel.spec.ts`, `progress.spec.ts`

**Interfaces:**
- Produces: hash field `timeout` (ms, or absent); `ClaimedJob.timeout: number | undefined`; CLAIM's trust check accepts a missing `timeout` and requires `^%d+$` when present.
- Produces: `complete(…, result: string | undefined, claimNext)` — stores `result` (JSON string) when given, PUBLISHes `{type:'completed', id, result}` to `keys.events` when settled. `fail(…)` PUBLISHes `{type:'failed', id, error}` only when final. A settle that is not settled publishes nothing.
- Produces: `cancel(client, keys, id): Promise<boolean>` — CANCEL deletes a waiting/delayed job (ZREM its set, DEL hash) or an active one (ZREM active, DEL hash — its token goes with it), PUBLISHes `{type:'canceled', id}`, answers 1; a completed/failed/absent job answers 0 and changes nothing.
- Produces: `progress(client, keys, id, token, value): Promise<boolean>` — PROGRESS sets `progress` only while the token holds; answers whether it did.
- The JSON in published messages is built by the scripts with `cjson.encode` from the stored strings (`result` decoded with `cjson.decode` first, so the message embeds the value, not a string of it).

- [ ] **Step 1: Write the failing tests** — a raw `duplicate()` subscribed to `keys.events` records messages: `'COMPLETE publishes the result once settled'`; `'a COMPLETE with a stale token publishes nothing'`; `'FAIL publishes only the final failure'`; `'CANCEL removes a waiting job and publishes canceled'`; `'CANCEL of an active job drops its token, so its COMPLETE is refused and publishes nothing'`; `'CANCEL of a completed job answers 0 and publishes nothing'`; `'CANCEL racing COMPLETE: exactly one outcome is published'` (both orders); `'PROGRESS writes only while the token holds'`; `'ADD stores timeout, CLAIM returns it'`; `'a hash with timeout "inf" is failed INVALID at claim'`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, see them pass.** Mutation pass (slice 1's script, scratchpad, `trap restore`, `perl alarm 90`) over: CANCEL's state test, COMPLETE's publish-only-when-settled, FAIL's publish-only-when-final, PROGRESS's token check. Record survivors; kill or justify each.
- [ ] **Step 5: Commit** — `feat(redis): Publish a job's outcome, cancel it, record its progress`.

---

### Task 3: The shared subscriber

**Files:**
- Create: `packages/redis/src/queue/events/subscriber.ts`
- Test: `packages/redis/src/queue/events/subscriber.spec.ts`

**Interfaces:**
- Produces: `listen(client: RedisClient, channel: string, listener: (message: string) => void): Promise<() => Promise<void>>` — the first listen on a client opens one `duplicate()` and keeps it in a module-level `WeakMap<RedisClient, …>`; each channel is `SUBSCRIBE`d once whatever its listener count; the returned function removes the listener, `UNSUBSCRIBE`s a channel with none left, and closes the connection when the client has none left. A listener that throws never reaches the others nor the connection. Concurrent first listens share one connection (the open is a single in-flight promise).

- [ ] **Step 1: Write the failing tests** — `'two queues on one client share one connection'` (`CLIENT LIST` count rises by exactly 1); `'a message reaches every listener of its channel and no other'`; `'the last unlisten closes the connection'`; `'concurrent first listens open one connection'`; `'a throwing listener does not stop the others'`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** — follow the subscription lifecycle of `src/channel/pubsub.ts`; share no code with it unless a function is reused as it is.
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit** — `feat(redis): One subscriber connection per client for queue events`.

---

### Task 4: The handle — `finished`, `cancel`, `result` in views

**Files:**
- Create: `packages/redis/src/queue/handle.ts`
- Modify: `packages/redis/src/queue/bind-queue.ts`, `packages/redis/src/queue/inspect.ts`, `packages/redis/src/queue/encode.ts`
- Test: `packages/redis/src/queue/handle.spec.ts`, `inspect.spec.ts` (extend)

**Interfaces:**
- Consumes: Task 2's `cancel`, Task 3's `listen`.
- Produces: `encodeResult(definition, value, queue): string | undefined` and `decodeResult(definition, json): { ok: true; value } | { ok: false }` beside `encodeData` (same parse-back rule; a queue without `result` encodes `undefined`).
- Produces: `jobHandle(client, definition, keys, id, deduplicated): JobHandle<R>`. `finished` listens **first**, then reads the job's state once: completed → resolve with the decoded result; failed → reject `FAILED` with `lastError`; absent → reject `NOT_FOUND`; otherwise wait for its event: completed → resolve (decode the published result), failed → `FAILED`, canceled → `CANCELED`; `timeout` → `WAIT_TIMEOUT`. It always unlistens before settling. A published result the schema refuses rejects `INVALID`.
- Produces: `BoundQueue.cancel(id)`; `JobView.progress` (0 when absent) and `JobView.result` (decoded, `undefined` when absent or unreadable).

- [ ] **Step 1: Write the failing tests** — `'finished resolves with the result a worker returned'`; `'finished after the job already completed resolves from the stored result'`; `'finished on a failed job rejects FAILED with lastError, and the message holds no error text'`; `'finished rejects CANCELED when the job is canceled while waited on'`; `'finished on an unknown or removed job rejects NOT_FOUND at once'`; `'finished with timeout rejects WAIT_TIMEOUT and leaves no listener'` (subscriber connection closed afterwards); `'finished resolves with keepCompleted false, from the published result'`; `'cancel answers true for a waiting job and false for a finished one'`; `'get shows progress and the decoded result'`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit** — `feat(redis): A job handle that waits for its outcome and cancels it`.

---

### Task 5: The worker — result, progress, typed events, idle

**Files:**
- Modify: `packages/redis/src/queue/worker/context.ts`, `events.ts`, `run-job.ts`, `loop.ts`, `worker.ts`
- Test: `packages/redis/src/queue/worker/events.spec.ts`, `worker.spec.ts` (extend)

**Interfaces:**
- Consumes: Task 2's `complete(…, result)`, `progress`; Task 4's `encodeResult`.
- Produces: `emit(context, event, payload)` typed by `WorkerEvents`; a listener that throws is reported on `'error'`; an `'error'` listener that throws is swallowed.
- Produces: the handler's return is encoded with `encodeResult`; a result the schema refuses fails the attempt with `{ name: 'QueueError', message: 'INVALID: the result does not match the result schema' }` and no retry.
- Produces: `job.progress(n)` → PROGRESS, then `'progress'` is emitted; a value outside 0–100 throws `TypeError` `progress on "<queue>": progress is a number from 0 to 100`.
- Produces: events — `active` before the handler; `completed` (duration = handler start to settle) / `retrying` (with the delay) / `failed` from the settle reply; `stalled` per id in a claim reply's `stalled`; `failed` per id in `failedInvalid`.
- Produces: `idle()` resolves when the worker has no slot running and its last claim found nothing ready; immediately when that already holds; it is re-armed by the next claimed job.

- [ ] **Step 1: Write the failing tests** — `'the result reaches finished and get'`; `'a result the schema refuses fails the job INVALID without retry'`; `'progress is stored and emitted, and refused out of range'`; `'events arrive in order: active, completed'`; `'a retry emits retrying with its delay, the last attempt failed'`; `'a reclaimed lease emits stalled'`; `'a throwing listener is reported on error and the loop carries on'`; `'idle resolves once every added job is done, and at once on an idle worker'`; `'idle waits for a job claimed after it was first idle'`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** — keep every file under 250 lines and every function under 80; a new responsibility gets its own file.
- [ ] **Step 4: Run, see them pass**, then the worker specs 20× in a row.
- [ ] **Step 5: Commit** — `feat(redis): Results, progress, events and idle in the worker`.

---

### Task 6: The worker — signal, timeout, cancel, lost lease, close grace

**Files:**
- Create: `packages/redis/src/queue/worker/abort.ts` (per-job controllers and their sources)
- Modify: `packages/redis/src/queue/worker/context.ts`, `run-job.ts`, `leases.ts` (the lost callback), `worker.ts`
- Test: `packages/redis/src/queue/worker/abort.spec.ts`, `worker.spec.ts` (extend)

**Interfaces:**
- Consumes: Task 3's `listen` (the worker listens to `keys.events` for `canceled`), Task 2's scripts.
- Produces: one `AbortController` per running job, keyed by `id` **and** token; `signal.reason` is a `QueueError` with code `CANCELED`, `TIMEOUT`, `LEASE_LOST` or `CLOSED`.
- Produces: the handler is raced against its abort: on abort the slot stops awaiting it and —
  - `TIMEOUT` (the job's `timeout`, else the definition's): FAIL with `{ name: 'TIMEOUT', message: 'the attempt ran past its timeout' }` and the backoff delay; emit `retrying`/`failed`.
  - `CANCELED` (an event for this id, or RENEW reporting it lost after a CANCEL): no settle; emit `canceled`.
  - `LEASE_LOST` (RENEW reports it lost, not canceled): no settle; emit `error` with the `QueueError`.
  - `CLOSED` (`close`'s grace ran out): no settle; the lease is no longer renewed, so it lapses.
  The late handler's promise is kept handled (both handlers attached) and its outcome ignored.
- Produces: `close({ grace })` — stop claiming, wait for the slots up to `grace`, then abort the rest with `CLOSED`, stop the leases, unlisten, close the waiting connection; idempotent.

- [ ] **Step 1: Write the failing tests** — `'a handler past its timeout is aborted, recorded TIMEOUT once, and retried'` (handler ignores the signal and returns late: one FAIL, no COMPLETE, `attempt` 2 runs); `'cancel aborts a running job at once, through the event'` (signal aborted within 200 ms with a 30 s lease); `'a lost lease aborts with LEASE_LOST and frees the slot'` (take the token away by hand); `'close waits for a running job within grace'`; `'close aborts a handler that outlives grace, and resolves within grace'` (grace 200 ms, handler ignores the signal: close in 200–600 ms; after the lease another worker reclaims the job); `'the per-job timeout of add wins over the definition's'`; `'concurrency counts only jobs not yet aborted'`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, see them pass**, then the worker specs 20× in a row.
- [ ] **Step 5: Commit** — `feat(redis): Abort a job on cancel, timeout, lost lease or close`.

---

### Task 7: Exports, docs, changeset

**Files:**
- Modify: `packages/redis/src/index.ts` (export `WorkerEvents`, `ResultOf`, `Handler` and any new public type), `.changeset/` (new file, `'@nxgt/redis': minor`), `packages/redis/test/declarations/queue.ts` (a queue with `result`)
- Docs (controller dispatches the documentation agents): README Queue section, `docs/guide/queues.md` (results and `finished`, cancel, timeout, the signal, progress, events, idle, close with grace), troubleshooting entries for the new `QueueError` codes and `TypeError`s, roadmap Now entry updated.

- [ ] **Step 1: Export and add the declaration case.**
- [ ] **Step 2: Changeset** — "Queue jobs return a typed result; `add` gives a handle with `finished()` and `cancel()`; a job has a `timeout`, an `AbortSignal` and `progress()`; workers emit typed events and have `idle()` and `close({ grace })`."
- [ ] **Step 3: Green bar** — `bun run check && bun run typecheck && bun run build && bun run test && bun run verify:artifacts`.
- [ ] **Step 4: Commit** — `feat(redis): Export the queue's lifecycle`.

## After the tasks

- [ ] Fold in slice 1's deferred findings that touch the same code (from the ledger): settle reply lost in transit (comment), worker-level lost-lease walk (Task 6 covers it), `toView` NaN on a foreign hash, reply-parser strictness (`whole()` fractions, trailing elements, 0|1).
- [ ] `nxgt-review:review-before-a-pr` (code-reviewer, opus) until `ready: true`; `nxgt-docs:documentation-auditor` until `ok: true`.
- [ ] PR from `feat/redis-queue-lifecycle` into `feat/redis-queue`, naming the four merge conditions; merge once green.
