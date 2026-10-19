# Queue slice 3 (durable steps) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A handler's side effects run once per job, not once per attempt: `job.step(name, fn)` stores each step's result under fencing, and `job.key(name)` gives a stable idempotency key for what a crash between a side effect and its commit leaves to the other side.

**Architecture:**
- Two new scripts guard a step. STEP_BEGIN answers the stored value, or allows the run after checking the token and the lease. STEP_COMMIT stores the value under the same check.
- The worker wraps them in `job.step`. A refused begin or commit aborts the run as `LEASE_LOST`.
- Step values are encoded like `data`: JSON-safe, size-capped, optionally schema-checked.

**Tech Stack:** Bun 1.4.3 `RedisClient`, Lua (Redis 7.4), zod 4, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-18-redis-queue-design.md`, section "Running twice, and durable steps" (the authority), plus Storage (`step:<name>`), Scripts and Errors. Slices 1–2 are on `feat/redis-queue`. Their ledgers are `.superpowers/sdd/slice-1-ledger.md` and `slice-2-ledger.md` in the integration worktree.

## Global Constraints

- Everything from slices 1–2 binds:
  - durations;
  - key layout `queue:{<name>}:<part>`;
  - no data in messages;
  - call-time refusals read `<call> on "<queue>": <option> is <shape>`;
  - TSDoc on every export;
  - no import extensions;
  - files ≤ 250 lines, functions ≤ 80;
  - rejections in specs are held with `test/rejection.ts`, never `expect(p).rejects`;
  - no polling a short-lived state in specs.
- Step field: `step:<name>` in the job hash, holding the step's JSON. A step that returned `undefined` is stored as the empty string and read back as `undefined`.
- Step name: a string of 1 to 128 characters with no `:`. Anything else is a `TypeError`: `step on "<queue>": name is a string of 1 to 128 characters without ":"`. `job.key(name)` applies the same rule, with `key on "<queue>"`.
- `job.key(name)` returns `<queue name>:<job id>:<name>`, where the queue name is `definition.name`. Slice 4 adds the deployment prefix.
- A step value is checked as `data` is:
  - With `schema`: `fn`'s return goes through `schema` (its output is stored), and a stored value is parsed by `schema` on read.
  - Without `schema`: the value must survive the JSON round trip.
  - Refusals:
    - A refused value from `fn` is a `QueueError` `INVALID` from `step`, and the attempt fails without retry.
    - A stored value the schema refuses on read fails the job `INVALID` without retry.
- Step value size: no cap, as for `data` (slice 1 sets none; a cap for both is a later decision).
- Fencing:
  - STEP_BEGIN and STEP_COMMIT both require that the job's `token` equals the attempt's token, and that its `active` score (lease deadline) is greater than the server's now.
  - STEP_BEGIN on success also pushes the lease to now + lease, so a step starts with a full lease.
  - When refused, `step` rejects with `QueueError` `LEASE_LOST`, and the worker aborts that run with `LEASE_LOST` (by id **and** token).
- Round trips: a step that runs costs 2 (BEGIN + COMMIT). A step already stored costs 1 (BEGIN answers the value).
- A name used twice in one attempt is a `TypeError`: `step on "<queue>": step "<name>" already ran in this attempt`. This is checked before any round trip. Two different steps may run concurrently.
- `step` called after the run's signal aborted rejects at once with `signal.reason`, with no round trip.
- Steps survive retries and `retry(id)`. RETRY must not clear `step:*` fields. REMOVE and CANCEL delete the hash, steps included.
- New exported type: `StepOptions<S>`. `JobContext` gains `step` and `key`.
- Commit prefixes from AGENTS.md. Messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A worker whose lease lapsed but has not yet been reclaimed calls `step`. It must get `LEASE_LOST` and must not run `fn`, even though its token still holds. → Task 1 (`lease lapsed` case) and Task 3.
- Two attempts of one job (a stale one and the live one) reach the same step. Only the live one commits, and the stale one's later COMMIT is refused and does not overwrite. → Task 1 and Task 3.
- A step that returns `undefined` (the common "send a mail" step). It is stored and, on the next attempt, `fn` is not called again. → Task 2 and Task 3.
- A job that fails after step 2 of 3 and is retried by `retry(id)` resumes at step 3, without calling the first two `fn`s. → Task 3.
- A handler that runs the same step name twice in one attempt (a loop bug) gets a `TypeError`, never a silent reuse of the first value. → Task 3.

---

### Task 1: STEP_BEGIN and STEP_COMMIT

**Files:**
- Create: `packages/redis/src/queue/scripts/step.ts`
- Test: `packages/redis/src/queue/scripts/step.spec.ts`; also extend `admin.spec.ts` for RETRY keeping steps.

**Interfaces:**
- Produces: `stepBegin(client, keys, id, token, name, lease): Promise<{ stored: true; json: string } | { stored: false } | { lost: true }>`.
  - KEYS: job hash, `active`.
  - ARGV: token, field `step:<name>`, lease.
  - Reply `{1, json}` stored, `{0}` run allowed (lease pushed), `{-1}` lost.
- Produces: `stepCommit(client, keys, id, token, name, json): Promise<boolean>`. It writes only under the same check and answers whether it did.
- Uses the shared `NOW_LUA` and the strict whole-number helpers. Never duplicate a Lua body.

- [ ] **Step 1: Write the failing tests.**
  - `'BEGIN on a fresh step allows the run and pushes the lease'` (ZSCORE active grows to about now + lease)
  - `'BEGIN on a stored step answers its JSON and does not touch the lease'`
  - `'BEGIN with a stale token answers lost'`
  - `'BEGIN after the lease lapsed answers lost, though the token holds'` (write the active score in the past by hand)
  - `'BEGIN on a job not in active answers lost'` (removed or completed)
  - `'COMMIT stores the value only while token and lease hold'`
  - `'a stale COMMIT never overwrites the live attempt's value'` (two tokens)
  - `'COMMIT of the empty string stores it'` (the undefined marker)
  - `'RETRY keeps step fields'` (admin.spec)
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
  - Mutation pass (the slice 1 scratchpad method: trap restore, perl alarm 90, diff at the end). Mutate:
    - the token check in BEGIN and in COMMIT;
    - the lease-deadline check in BEGIN and in COMMIT (drop it, flip `>` to `>=` where it matters);
    - the lease push.
  - Kill each mutant, or show it is equivalent.
- [ ] **Step 5: Commit** `feat(redis): Fence a step with STEP_BEGIN and STEP_COMMIT`.

---

### Task 2: Step values and names

**Files:**
- Create: `packages/redis/src/queue/step-codec.ts` (or extend `encode.ts` if it stays ≤ 250 lines; it is 239 now, so prefer the new file)
- Test: `packages/redis/src/queue/step-codec.spec.ts`

**Interfaces:**
- Produces: `checkStepName(queue: string, call: 'step' | 'key', name: unknown): string`. It throws the TypeError from Global Constraints.
- Produces: `encodeStep(queue, name, value, schema?): string`.
  - `undefined` becomes `''`, but only when there is no schema or the schema accepts `undefined`.
  - A refused value, or one that does not survive JSON, throws `QueueError` `INVALID`. The message names the queue and the step and holds no value, e.g. `step on "<queue>": step "<name>" returned a value that has no JSON form`, with the zod issue codes when a schema refused it.
  - Uses slice 2's `check()` wrapper, so a throwing schema reads as a refusal.
- Produces: `decodeStep(json, schema?): { ok: true; value } | { ok: false }`. It never throws, and `''` gives `undefined`.

- [ ] **Step 1: Write the failing tests:**
  - names: empty, 129 characters, containing `:`, a non-string → TypeError; 128 characters → ok;
  - `undefined` round trip;
  - an object round trip;
  - `[]` stays `[]`;
  - `Date` without a schema is refused (no JSON form), with a schema that transforms it is accepted;
  - a throwing schema → INVALID;
  - a decode the schema refuses → `{ ok: false }`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit** `feat(redis): Encode a step's value and check its name`.

---

### Task 3: `job.step` and `job.key` in the worker

**Files:**
- Create: `packages/redis/src/queue/worker/steps.ts`
- Modify: `packages/redis/src/queue/worker/run-job.ts` (build the context), `packages/redis/src/queue/worker/types.ts` (`JobContext`, `StepOptions`)
- Test: `packages/redis/src/queue/worker/steps.spec.ts`, `packages/redis/test/types/queue.ts`

**Interfaces:**
- Consumes: Task 1 `stepBegin`/`stepCommit`, Task 2 codec, slice 2's `abortRun(context, 'LEASE_LOST', id, token)` and the run's signal.
- Produces: `JobContext<S>` gains:
  - `step<T>(name: string, fn: () => T | Promise<T>): Promise<T>`
  - `step<Z extends z.ZodType>(name: string, fn: () => z.input<Z> | Promise<z.input<Z>>, options: StepOptions<Z>): Promise<z.output<Z>>`
  - `key(name: string): string`

  `StepOptions<Z> = { schema: Z }`.
- Behaviour, in order:
  1. Check the name (TypeError).
  2. Check the duplicate name in this attempt (TypeError).
  3. Check the signal (reject with its reason).
  4. BEGIN:
     - lost → abort the run with LEASE_LOST and reject with that QueueError;
     - stored → decode; refused → fail the job INVALID without retry (throw a QueueError INVALID that run-job maps to a no-retry FAIL); else return the value.
  5. Otherwise run `fn` and encode its result (an encode refusal → INVALID, no retry).
  6. COMMIT: refused → abort LEASE_LOST and reject; ok → return the value as decoded from what was stored (so with or without a fresh run the handler sees the same thing).

  A throw from `fn` propagates as the handler's own error (normal retry rules) and records nothing.

- [ ] **Step 1: Write the failing tests:**
  - `'a step runs once per job: the retry gets the stored value and fn is not called'` (the handler throws after the step on attempt 1)
  - `'a step returning undefined is not run again on retry'`
  - `'retry(id) after a failure at step 3 resumes at step 3'`
  - `'a stale attempt whose lease lapsed gets LEASE_LOST from step and fn does not run'` (gate attempt 1 inside its handler past its lease with a short lease; let a second worker reclaim it, then release attempt 1 into a step)
  - `'a stale COMMIT is refused: the live attempt's value is the one stored'`
  - `'the same name twice in one attempt is a TypeError before any round trip'` (count script calls)
  - `'two different steps run concurrently'` (Promise.all)
  - `'step after the signal aborted rejects with the signal's reason'` (cancel the job, then call step)
  - `'a step value the schema refuses on read fails the job INVALID without retry'` (write a foreign value to `step:<name>` by hand)
  - `'job.key is stable across attempts'` (`mails:<id>:send`, same on attempts 1 and 2)
  - `'a step that runs costs two scripts, a stored one costs one'` (via `scriptCalls`)
- **Types** (`test/types/queue.ts`):
  - with `schema`, the return is `z.output` and `fn` must return `z.input` (a wrong shape is an error);
  - without a schema, the return is `fn`'s awaited type;
  - `job.key(1)` is an error;
  - `step('x', fn, { schema: 5 })` is an error.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Keep `run-job.ts` ≤ 250 lines; all step logic lives in `steps.ts`.
- [ ] **Step 4: Run them and see them pass.** Then run the worker specs 30× in a row.
- [ ] **Step 5: Commit** `feat(redis): Durable steps and a stable key in the handler`.

---

### Task 4: `finished({ timeout })` is a hard bound (slice 2 debt)

**Files:**
- Modify: `packages/redis/src/queue/handle.ts` (`waitFinished`)
- Test: `packages/redis/src/queue/handle.spec.ts`

**Interfaces:**
- `waitFinished` races its first `readStored` and its `flush` against `done`, so the `timeout` rejects `WAIT_TIMEOUT` on time even when a connection hangs. The cleanup (unlisten, interval, timer) still runs on every path.

- [ ] **Step 1: Write the failing test.** `'finished({ timeout }) rejects on time even when the first read never answers'`: use a proxy client whose HMGET never resolves, with timeout 200 ms, and assert the rejection arrives in under 600 ms.
- [ ] **Step 2: Run it and see it fail.** **Step 3: Implement.** **Step 4: Run it and see it pass**, then run handle.spec 30×.
- [ ] **Step 5: Commit** `fix(redis): Make finished's timeout a hard bound`.

---

### Task 5: Exports, the guide's "running twice" section, changeset

**Files:**
- Modify: `packages/redis/src/index.ts` (export `StepOptions`), `packages/redis/test/declarations/queue.ts` (a handler using a step with a schema), `.changeset/` (new file, `'@nxgt/redis': minor`).
- Docs (the controller dispatches the documentation agents):
  - the guide section "Running twice": what at-least-once means, code outside a step runs again, every side effect goes in a step, `job.key` for the provider's idempotency key or `redis.idempotency.*.run`, steps survive `retry`, `remove` and re-add to start over, the cost of two round trips;
  - troubleshooting for the step TypeErrors, the step INVALID messages and LEASE_LOST from `step`;
  - README rows;
  - the roadmap entry.

- [ ] **Step 1: Export and add the declaration case.**
- [ ] **Step 2: Changeset.** "Queue handlers get durable steps: `job.step(name, fn)` runs a side effect once per job, not once per attempt, fenced against a stale worker, and `job.key(name)` gives a stable idempotency key."
- [ ] **Step 3: Green bar.** Run `bun run check && bun run typecheck && bun run build && bun run test && bun run verify:artifacts`.
- [ ] **Step 4: Commit** `feat(redis): Export durable steps`.

## After the tasks

- [ ] `nxgt-review:review-before-a-pr` (code-reviewer, opus) until `ready: true`, and `nxgt-docs:documentation-auditor` until `ok: true`.
- [ ] A PR from `feat/redis-queue-steps` into `feat/redis-queue` that names the four merge conditions. Merge it once green.
