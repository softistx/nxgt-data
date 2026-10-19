# Queue slice 5 (flow control) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pause()`/`resume()`, a queue-wide `rateLimit` that every worker of the queue shares, and `debounce`/`throttle` on `add`.

**Architecture:** All three live in the scripts, so every process sees the same truth.
- **Pause:** a `paused` key gates the claim body (`CLAIM_FN`, shared by CLAIM, COMPLETE and FAIL).
- **Rate limit:** the claim body admits jobs through the GCRA of `defineRateLimit`. Its Lua becomes a shared function, not a copy, and it keeps its state in the queue's `rate` key.
- **Dedupe:** ADD reads and writes `dedupe:<key>`.

Neither a paused queue nor a rate-limited one may make a worker spin. The claim body leaves no `wake` token and reports a wait instead.

**Tech Stack:** Bun 1.4.3 `RedisClient`, Lua (Redis 7.4), zod 4, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-18-redis-queue-design.md` ("Shape of the API", "Storage", "Scripts" ADD/CLAIM/PAUSE/RESUME, "Decisions"). The owner chose the option shape on 2026-10-18: `debounce: { key, wait }` and `throttle: { key, window }`. Task 4 writes it into the spec.

## Global Constraints

- **Inherited from slices 1–4:**
  - TSDoc on every export; no import extensions.
  - Files ≤ 250 lines and functions ≤ 80. `types.ts` is at 211 lines, so new public types go in a file of their own.
  - `rejection()` instead of `expect(p).rejects`.
  - Scripts trust only state they could have written; every loop has a cap; replies report shapes, never values.
  - Commits use the unscoped prefixes `feat:`, `fix:`, `chore:` and `docs:`.
  - Admin calls pass through after `redis.close()`.
- **Round trips, unchanged and pinned:** `add` is 1, CLAIM is 1, and a busy worker is 1 per job. `pause`, `resume` and `counts` are 1 each.
- **No spin.**
  - While the queue is paused, or while `ready` holds jobs that the rate refuses, the claim body leaves **no** `wake` token. It deletes the token if one is there.
  - Its `next` wait is: the 5 s cap when paused; when rate-limited, the GCRA's `retryAfter` for one job, if that is sooner than the next delayed job.
  - A worker of a paused queue makes at most one CLAIM per cap.
- **Pause.**
  - `pause()` sets `paused`.
  - The claim body still reclaims lapsed leases and promotes due delayed jobs while paused, so `counts` stays honest. It pops nothing.
  - Running jobs carry on to their settle. A settle while paused claims nothing next.
  - `resume()` deletes `paused` and leaves one `wake` token when `ready` holds jobs, so a blocked worker starts at once and passes the baton.
  - Both are idempotent.
  - `counts()` gains `paused: boolean`, read in the same script.
- **Rate limit.**
  - The option is `rateLimit: { limit, per, burst? }`. `limit` and `burst` are whole numbers ≥ 1, and `burst` defaults to `limit`. `per` is a `Duration`, ms or `'1m'`.
  - The numeric checks are `defineRateLimit`'s own (`MAX_BURST_PER`, `MAX_REFILL`). Extract them so both definitions call one function. The message names the queue and `rateLimit`, in `defineQueue`'s style.
  - The definition freezes the option.
  - The claim body admits `m = min(n, remaining)`, where `remaining` comes from a GCRA peek at cost 1. After popping `k ≤ m` jobs, it charges cost `k` once, written only when `k > 0`.
  - A reclaimed lease is not charged.
  - The GCRA's `now` is the claim script's own `TIME`, in µs.
  - The state lives in `queue:{<name>}:rate`, one per queue across all processes.
- **Debounce / throttle.**
  - `add(data, { debounce: { key, wait } })` and `add(data, { throttle: { key, window } })`.
  - `key` follows the same rule as `id`: 1–256 characters, no braces. `wait` and `window` are `Duration`s of at least 1 ms.
  - `debounce` and `throttle` exclude each other and both refuse `id`. `debounce` also refuses `delay` and `at`, since it sets the run time itself. Each refusal is a `TypeError` before any round trip, in `resolveAdd`'s style.
  - Both work in `addMany`, item by item, in order.
- **Debounce in ADD.**
  - If `dedupe:<key>` names a job whose hash says `waiting` or `delayed`, ADD:
    - replaces that job's `data`;
    - moves it to `delayed` at `now + wait` (out of `ready` if it was there);
    - keeps its priority, attempts and timeout;
    - refreshes the key's PX;
    - answers with that job's id. The handle then has `deduplicated: true`.
  - Otherwise (no key, or the job named is active, finished or gone), ADD adds a new job at `now + wait` and points the key at it. A run that is under way is never overwritten.
  - The key's PX is `wait + 86_400_000`. It is a memory bound only: correctness rests on the job's state, never on the TTL.
- **Throttle in ADD.** If `dedupe:<key>` exists, ADD adds nothing and answers with the id it names (`deduplicated: true`). Otherwise it adds the job and sets the key to its id with `PX window`. The key outlives the job: a second add within the window is deduplicated, even after the first job finished.
- **ADD's reply, per job:** `0` (added), `1` (the given `id` existed), or the id string of the job that holds the dedupe key. `parseAddReply` reports shapes only.

## Review Focus

- **No spin on a paused queue:** with two idle workers, count CLAIM-bearing scripts over 2 s. Each worker makes at most one per cap.
- **No spin on a rate-limited queue:** with `limit: 1, per: '1s'` and five ready jobs, the jobs start about 1 s apart, and CLAIMs per second stay single-digit.
- **`resume()` wakes a blocked worker** within 500 ms, not after the 5 s cap.
- **Debounce against a claim:** a debounce that arrives once the job is active adds a new job. The running job's `data` is not replaced, and it finishes with its own data.
- **The rate holds across workers:** two workers on one queue with `limit: 3, per: '1s'` and ten jobs start at most 3 in the first second. A COMPLETE's claim-next is charged too.

---

### Task 1: Split first, with no spec touched

**Files:**
- Create: `packages/redis/src/queue/scripts/claim-body.ts`. Move `CLAIM_FN`, `PUBLISH_FN`, `NOW_LUA` and their doc comments here. `claim.ts` keeps `CLAIM`, `scriptKeys`, `newToken` and `claim`, and re-imports what it needs.
- Modify: `packages/redis/src/rate-limit/gcra.ts`. Turn `gcraSource(now)` into an exported Lua function source, `GCRA_FN`, which defines `local function gcra(key, now_us, per, limit, burst, cost, write)` and returns `{allowed, remaining, resetAfter, retryAfter}`. The rate-limit script becomes `GCRA_FN` plus a call with `KEYS[1]` and its ARGV. The script's behaviour and replies stay byte for byte.
- Modify: `packages/redis/src/rate-limit/define-rate-limit.ts`. Extract the numeric checks into `checkRate(call: string, owner: string, limit: number, per: number, burst: number | undefined): void`. `owner` is the subject of the sentence, such as `"api"`, or `"mails" has a rateLimit whose`. Keep every existing message of `defineRateLimit` identical.
- Update the imports of every user of the moved names.

- [ ] **Step 1:** Make the moves.
- [ ] **Step 2:** Run `bun test src/rate-limit src/queue` from packages/redis. Every spec passes unchanged, and none was edited.
- [ ] **Step 3:** Run the green bar.
- [ ] **Step 4:** Commit `chore: Split the claim body out, and share the GCRA as a Lua function`.

---

### Task 2: `pause()`, `resume()` and `counts().paused`

**Files:**
- Modify: `queue/keys.ts`, adding `paused`, `rate` and `dedupe` (the prefix `queue:{<name>}:dedupe:`, for scripts). Also modify `scripts/claim.ts` `scriptKeys`, appending `paused` (KEYS[9]) and `rate` (KEYS[10]) after `events`.
- Modify: `scripts/claim-body.ts` (the paused gate and the no-wake rule), and `scripts/admin.ts` (`PAUSE`, `RESUME`, and `COUNTS` gains `EXISTS paused`).
- Modify: `queue/inspect.ts`, `queue/bind-queue.ts`, and `queue/types.ts` (`QueueCounts = Record<JobState, number> & { paused: boolean }`; `BoundQueue.pause(): Promise<void>` and `resume(): Promise<void>`, with TSDoc).
- Test: `scripts/admin.spec.ts` and `scripts/claim.spec.ts` (or a new `scripts/pause.spec.ts` if claim.spec would pass 250 lines), plus `worker/pause.spec.ts`.

**Interfaces:**
- `claim(n, lease, tokens, now)` keeps its signature. The gate reads `EXISTS KEYS[9]`.

- [ ] **Step 1: Write the failing tests.**
  - `'a paused claim reclaims and promotes but pops nothing, and leaves no wake token'`: seed one lapsed lease, one due delayed job and one ready job, with a token in `wake`.
  - `'a settle while paused claims nothing next'`.
  - `'RESUME deletes paused and leaves one wake token when ready holds jobs; none when it is empty'`.
  - `'pause and resume are idempotent'`.
  - `'counts reports paused'`.
  - Worker: `'a paused queue does not spin'`. Use two workers and count scripts through `scriptCalls` over 2 s; each worker makes at most one claim per 5 s cap, plus its first.
  - Worker: `'resume wakes a blocked worker within 500 ms'`.
  - Worker: `'pause lets a running job finish'`.
  - `'pause passes through after redis.close()'`: a wired queue.
- [ ] **Step 2: Run the tests and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and watch them pass.** Run a mutation pass on the gate, the no-wake rule and RESUME's wake, and kill each mutant.
- [ ] **Step 5: Commit** `feat: Pause and resume a queue`.

---

### Task 3: `rateLimit`

**Files:**
- Create: `queue/rate.ts`, holding `resolveRateLimit(value, call, name)`. It returns the frozen `{ limit, per, burst }` in ms, or `undefined`, and calls `checkRate`.
- Create: `queue/flow-types.ts`, holding `QueueRateLimit` (the input type), with TSDoc. Re-export it from `src/index.ts`.
- Modify: `queue/define-queue.ts` (the option) and `queue/types.ts` (`QueueInput.rateLimit?: QueueRateLimit`, and the definition field).
- Modify: `scripts/claim-body.ts`, `scripts/claim.ts`, and `scripts/settle.ts` with its client caller. Every CLAIM-bearing script passes `per`, `limit` and `burst`, with `0` meaning no limit.
- Test: `scripts/rate.spec.ts`, `worker/rate.spec.ts`, `define-queue.spec.ts` (new cases only), `test/types/queue.ts`.

**Interfaces:**
- `claim(n, lease, tokens, now, rate)`: `rate` is `{per, limit, burst}` in Lua, or `nil`. `now_us` comes from the same `TIME`.

- [ ] **Step 1: Write the failing tests.**
  - `'claim admits at most the rate and charges what it popped'`: `limit: 2, per: 1000`, five ready, `n: 5` gives 2. A second claim at once gives 0, with `next` ≤ the GCRA's retryAfter and no wake token.
  - `'a claim that pops fewer than admitted charges only what it popped'`: one ready job, `limit 5`. Then a peek shows 4 remaining.
  - `'a reclaimed lease is not charged'`.
  - `'no rateLimit, no rate key written'`.
  - `'the claim body refuses a rate state it could not have written as defineRateLimit does'`: a full bucket, then overwritten. Mirror one case from `rate-limit/stored-state.spec.ts`.
  - Worker: `'two workers share one rate'` (Review Focus).
  - Worker: `'a rate-limited queue does not spin'` (Review Focus).
  - defineQueue: each refusal (`limit` 0, `per` `'0s'`, `burst` 1.5, `burst × per` too large) and its exact message.
  - Types: `rateLimit: { limit: 1, per: '1 m' }` and `rateLimit: { per: '1m' }` are errors.
- [ ] **Step 2: Run the tests and watch them fail.** **Step 3: Implement.** **Step 4: Run the tests and watch them pass.** Then run a mutation pass: drop the charge, charge `m` instead of `k`, and push wake while limited. Kill each mutant.
- [ ] **Step 5: Commit** `feat: Rate-limit a queue across its workers`.

---

### Task 4: `debounce` and `throttle`

**Files:**
- Create: `queue/dedupe.ts`, holding `resolveDedupe(options, call, queue)`. It checks the rules in Global Constraints and returns `{ mode: '' | 'debounce' | 'throttle', key: string, ttlMs: number }`. `resolveAdd` calls it and adds its refusals.
- Modify: `queue/flow-types.ts`, adding `DebounceOptions = { key: string; wait: Duration }` and `ThrottleOptions = { key: string; window: Duration }`. Export both.
- Modify: `queue/types.ts` (`AddOptions` gains `debounce?` and `throttle?`, as a union that makes `debounce` with `id`, `delay`, `at` or `throttle` a type error), `scripts/add.ts`, `scripts/replies.ts` (`parseAddReply`), and the handle building in `bind-queue.ts` / `handle.ts`.
- Modify: the spec, in "Shape of the API" (an example line for each), "Storage" (`dedupe:<key>` and its PX rule), and "Scripts" ADD (the reply, and the state check over the TTL).
- Test: `scripts/dedupe.spec.ts`, `queue/dedupe.spec.ts` (handle and addMany), `test/types/queue.ts`, `test/declarations/queue.ts`.
- Changeset: `.changeset/redis-queue-flow.md`, `'@nxgt/redis': minor`, covering slice 5 as a whole.

**Interfaces:**
- ADD ARGV per job grows from 7 to 10: `…, mode, dedupeKey, ttlMs`, where `mode` is `''`, `'d'` or `'t'`. The dedupe prefix is a new ARGV after the job-key prefix.

- [ ] **Step 1: Write the failing tests.**
  - `'debounce replaces the data of a waiting job and pushes its run time'`: it was in `ready`, so it moves to `delayed` at `now + wait`, keeps its priority, and the reply is its id.
  - `'debounce on an active job adds a new one and leaves the running data alone'` (Review Focus).
  - `'debounce after the job finished adds a new one'`.
  - `'debounce ignores the TTL when the job named is waiting'`: a key with PX 1 still debounces while the job waits, because the state decides, not the TTL. Seed the key without the job, then with it.
  - `'throttle keeps the first and answers its id within the window, even once it finished'`; `'throttle after the window adds again'`.
  - `'addMany debounces in order within one call'`: two items with one key give one job holding the second item's data, and two handles with the same id, the second `deduplicated`.
  - Each refusal is a `TypeError` with its exact message and no round trip: `debounce` with `id`, with `delay`, or with `throttle`; a bad key; `wait: 0`.
  - Types: the refused combinations are `@ts-expect-error`.
- [ ] **Step 2: Run the tests and watch them fail.** **Step 3: Implement.** **Step 4: Run the tests and watch them pass.** Run the worker specs 20× in a row. Then run a mutation pass: drop the state check (trust the key alone), move data on an active job, and skip the PX refresh. Kill each mutant.
- [ ] **Step 5: Green bar:** `bun run check && bun run typecheck && bun run build && bun run test && bun run verify:artifacts`.
- [ ] **Step 6: Commit** `feat: Debounce and throttle jobs on add`.

**Docs** (the controller sends these to the documentation agents after Task 4):
- Guide: a "Flow control" section in `queues.md` covering pause/resume, rateLimit (shared by every worker, and how it differs from `bindRateLimit`), and debounce versus throttle, with a use for each (reindex after edits, at most one digest per hour).
- README rows; the troubleshooting entries for every new refusal; the roadmap.

## After the tasks

- [ ] A final review on Opus (`nxgt-review:code-reviewer`) until `ready: true`, and `nxgt-docs:documentation-auditor` until `ok: true`.
- [ ] A PR into `feat/redis-queue` that names the four merge conditions; merge it once green.
