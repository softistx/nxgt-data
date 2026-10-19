# Queue slice 4b (retry fresh) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `retry(id, { fresh: true })` puts a failed job back with its stored step values cleared, so every step runs again. `retry(id)` keeps them and resumes at the step that failed.

**Architecture:** RETRY gains a flag. When the flag is set, the same script deletes every `step:*` field of the job's hash, so the retry and the clearing are one atomic change. The client-side `retry` checks the option and passes the flag. `job.key` is unchanged, since it is per job id.

**Tech Stack:** Bun 1.4.3 `RedisClient`, Lua (Redis 7.4), zod 4, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-18-redis-queue-design.md`, "Running twice, and durable steps": steps survive retries and `retry(id)`. The owner added `fresh` on 2026-10-18; Task 2 amends the spec.

## Global Constraints

- Everything from slices 1–4 binds. That covers TSDoc on every export, no import extensions, files ≤ 250 lines and functions ≤ 80, `rejection()` instead of `expect(p).rejects`, and the unscoped commit prefixes `feat:`, `fix:`, `chore:` and `docs:`.
- `retry(id, options?)` takes `options: { fresh?: boolean }`.
  - `fresh` must be `true`, `false` or absent.
  - Anything else is a `TypeError`, raised before any round trip: `retry on "<queue>": fresh is true or false`.
  - Other keys are treated as `add`'s options treat unknown keys. Read `resolveAdd` and match it.
- With `fresh: true`, RETRY deletes every hash field whose name starts with `step:`, in the same script and only when the retry happens. A job that is not retryable keeps its steps.
- With `fresh` absent or false, behaviour is byte-for-byte today's, and the existing RETRY specs pass unchanged.
- `job.key(name)` is the same before and after a fresh retry.
- Admin calls, `retry` included, still pass through after `redis.close()` (slice 4, ruling W2).
- New exported type: `RetryOptions`.

## Review Focus

- A fresh retry of a job that failed at step 3 runs steps 1–3 again, so each `fn` is called again. `job.key` has the same value.
- A fresh retry on a job that is not failed (waiting, active, completed, or absent) changes nothing: its steps stay and the answer is `NOT_FOUND`, as today.
- A job whose `data` contains the text `step:` is not touched. Only field names are matched, never values.
- A step named so that its field is a prefix of another (`step:a` and `step:ab`) has both cleared. Fields that are not steps (`stepCount`, if it ever exists, and `data`) are kept: match `step:` with its colon.

---

### Task 1: RETRY clears steps when asked

**Files:**
- Modify: `packages/redis/src/queue/scripts/admin.ts` (RETRY), and its caller `retryJob` in `packages/redis/src/queue/inspect.ts` (or wherever `retryJob` lives)
- Test: `packages/redis/src/queue/scripts/admin.spec.ts`

**Interfaces:**
- RETRY ARGV: job-key prefix, id, fresh (`'1'` or `'0'`). After the retry succeeds and before `return 1`, when `ARGV[3] == '1'`, it runs `HKEYS` and `HDEL`s each field with `string.sub(f, 1, 5) == 'step:'`.
- `retryJob(..., fresh: boolean)` passes `fresh ? '1' : '0'`.

- [ ] **Step 1: Write the failing tests.**
  - `'RETRY with fresh clears every step field and keeps data, priority and attempts'`: seed `step:a`, `step:ab` and `data` containing `"step:x"`.
  - `'RETRY without fresh keeps step fields'`: the existing case. Keep it.
  - `'RETRY with fresh on a job that is not failed changes nothing, steps included'`.
- [ ] **Step 2: Run the tests and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and watch them pass.** Then run a mutation pass with the slice 1 method. Drop the `fresh` check, drop the colon from `'step:'`, and move the HDEL before the retryable checks. Kill each mutant.
- [ ] **Step 5: Commit** `feat: Clear a job's steps on a fresh retry`.

---

### Task 2: `retry(id, { fresh })`

**Files:**
- Modify: `packages/redis/src/queue/types.ts` (`retry(id: string, options?: RetryOptions): Promise<void>`, `RetryOptions`, and TSDoc that says steps are kept by default, cleared by `fresh`, and that `job.key` is unchanged)
- Modify: `packages/redis/src/queue/bind-queue.ts`, `packages/redis/src/index.ts` (export `RetryOptions`)
- Modify: `docs/superpowers/specs/2026-10-18-redis-queue-design.md`, in the "Running twice" bullet "Steps survive retries and `retry(id)`". Add: `retry(id, { fresh: true })` clears them, and `job.key` is unchanged.
- Test: `packages/redis/src/queue/worker/steps.spec.ts` (or a new `retry-fresh.spec.ts` if steps.spec would pass 250 lines in a way that matters), `test/types/queue.ts`, `test/declarations/queue.ts`
- Changeset: `.changeset/redis-queue-retry-fresh.md`, `'@nxgt/redis': minor`

- [ ] **Step 1: Write the failing tests.**
  - `'retry(id, { fresh: true }) runs every step again; retry(id) resumes'`. Use a worker whose handler runs steps a, b, c and throws after c on its first two runs. Then:
    1. `retry(id)` reruns only the code after the steps;
    2. a failure followed by `retry(id, { fresh: true })` calls the fn of a, b and c again;
    3. `job.key('a')` is equal across all runs.
  - `'retry with fresh that is not true or false is a TypeError before any round trip'` (count scripts).
  - `'retry with fresh passes through after redis.close()'`: a wired queue that is closed answers NOT_FOUND or retries, never CLOSED.
  - Types: `retry(id, { fresh: 'yes' })` is an error, and so is `retry(id, { fresh: 1 })`.
- [ ] **Step 2: Run the tests and watch them fail.** **Step 3: Implement.** **Step 4: Run the tests and watch them pass.** Run the worker specs 20× in a row.
- [ ] **Step 5: Green bar:** `bun run check && bun run typecheck && bun run build && bun run test && bun run verify:artifacts`.
- [ ] **Step 6: Commit** `feat: Retry a job fresh, with its steps run again`.

**Docs** (the controller sends these to the documentation agents):
- Guide, "Running twice" › persistence: `retry(id)` resumes and `retry(id, { fresh: true })` starts over. Explain when to use it: after fixing a bug that made a step store a wrong value. Say that `job.key` is unchanged, so a provider that deduplicates on it still answers from its cache; vary the key on purpose if the downstream call must happen again.
- Guide, "Inspecting and repairing": add the `fresh` option.
- README: add `fresh` to the `retry` row.
- Troubleshooting: an entry for the `fresh` TypeError, and the INVALID-step entry pointing to `fresh` as the way out once the step is fixed.

## After the tasks

- [ ] `nxgt-review:review-before-a-pr` (the code-reviewer agent) until `ready: true`, and `nxgt-docs:documentation-auditor` until `ok: true`.
- [ ] A PR into `feat/redis-queue` that names the four merge conditions; merge it once green.
