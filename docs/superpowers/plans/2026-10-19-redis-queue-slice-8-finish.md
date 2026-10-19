# Queue slice 8 (finish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the queue before it is released. This slice:
- regroups `src/queue/` into one folder per subject;
- adds the local benchmark the spec promises, and publishes its numbers in the guide;
- adds an example application;
- brings the package metadata, the roadmap and `AGENTS.md` up to date.

**Architecture:** The regroup is pure moves: no behaviour change, and no spec edited beyond its import paths. The benchmark is a repository script against a Redis it starts itself, never run in CI. The example is a small private workspace app over the wiring (`defineRedis` with `queues`), with a spec against a real Redis.

**Tech Stack:** Bun 1.4.3 `RedisClient`, Redis 7.4, zod 4, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-18-redis-queue-design.md`: "Success", "Performance" (the benchmark), "Documentation", and "Slices" item 8.

## Global Constraints

- **House rules:** files ≤ 250 lines, functions ≤ 80 lines, TSDoc on every export, no import extensions, tabs. Use `rejection()`, never `expect(p).rejects`. Commits take unscoped prefixes.
- **The public surface of `@nxgt/redis` does not change in this slice.** `src/index.ts` exports exactly the same names. Check with `verify:artifacts` and by diffing the built `dist/index.d.ts` export list before and after.
- **Benchmark:**
  - It is `scripts/bench-queue.ts`, run by `bun run bench:queue` at the root, and never in CI or in `bun run test`. Follow the repo-script conventions of `scripts/` (see `scripts/redis.ts` for how a Redis binary is found and started).
  - Scenarios: add then process 100 000 jobs at concurrency 1, 8 and 64, reporting jobs/s for adding (with `addMany`) and for processing. Then the end-to-end latency, from `add` to the handler starting, of an immediate job on an idle worker: 1 000 samples, p50 and p99.
  - It prints a Markdown table plus the machine (CPU model, cores, OS), the Bun, Redis and `@nxgt/redis` versions.
- **Example:**
  - It lives in `examples/queue-mails`: `private`, unscoped (`queue-mails-example`), with `@nxgt/redis` by `workspace:^`, laid out like `examples/mongo-backup-job`.
  - It shows a wired queue with `defineRedis({ queues })`, a producer and a worker as separate entry points, a schema-checked payload and result, a schedule (a nightly digest by cron in a time zone), groups per tenant with a `concurrency`, durable steps with `job.key`, and a graceful close on SIGTERM.
  - The environment is parsed once with zod in `src/env.ts`.
  - Its spec runs against a real Redis started from `$REDIS_BIN`, as `examples/hono-api/test/redis.ts` does.
  - Keep it short. Per the "simple API first" rule, a long example means a missing entry point; report any.

## Review Focus

- **The regroup really is pure.** `git diff -M --stat` shows renames. The non-rename hunks are import lines only. Spec counts are equal before and after: 972 redis tests.
- **The benchmark measures what it says:**
  - processing time runs from the first claim to the last `completed` event, not including adding;
  - latency is per job, from just before `add` to the handler's first line;
  - Redis is flushed between scenarios;
  - the worker is closed and the Redis stopped on exit, including on Ctrl-C.
- **The example runs** with `bun run --filter queue-mails-example test` and `typecheck`, and the root's `bun run test` runs it after the packages.

---

### Task 1: Regroup `src/queue/` (pure moves)

**Files:**
- Move under `packages/redis/src/queue/`, specs alongside their files:
  - `definition/`: `define-queue`, `check`, `duration`, `name`, `group`, `rate`, `backoff`, `dedupe`.
  - `types/`: `types`, `flow-types`, `handle-types`, `result-types`.
  - `binding/`: `bind-queue`, `encode`, `keys`, `handle`, `life`, `timers`, `outcome`, `round-trip`, `step-codec`.
  - `inspect/`: `inspect`, `job-admin`, `view`.
  - `scripts/claim/`: `claim`, `claim-body`, `claim-steps`, `replies`, `wake`.
  - `scripts/groups/`: `groups`, `groups-mode`.
  - `scripts/schedule/`: the schedule scripts.
  - `worker/`, `events/` and `schedule/` stay.
- The implementer may move a file to a better-fitting folder from that list, and must say why. No folder over about 12 source files.

- [ ] **Step 1:** Record the before state: `bun test` in packages/redis (the count) and the built `dist/index.d.ts` export names.
- [ ] **Step 2:** `git mv` the files, then fix the import paths. Change no other line.
- [ ] **Step 3:** Run the green bar. The test count must equal step 1's, and the export names must be identical.
- [ ] **Step 4:** Commit `chore: Regroup the queue's sources by subject`.

---

### Task 2: The benchmark

**Files:**
- Create `scripts/bench-queue.ts`, plus its pure helpers (percentiles, the table) tested in `scripts/bench-queue.spec.ts`.
- Modify the root `package.json`, adding a `bench:queue` script.

- [ ] **Step 1: Write the failing spec** for the helpers: `percentile([…], 0.5)` and `percentile([…], 0.99)` on known arrays, and the table rendering.
- [ ] **Step 2: Implement the script** as the Global Constraints describe. Start Redis on a free port, and stop it in a `finally` and on SIGINT.
- [ ] **Step 3: Run it once.** Save the output to `.superpowers/sdd/<plan>/bench-output.md`. It feeds the docs.
- [ ] **Step 4: Green bar, then commit** `feat: Benchmark the queue locally`.

---

### Task 3: The example

**Files:**
- Create `examples/queue-mails/`: `package.json`, `tsconfig.json`, `biome.json`, `README.md`, and in `src/`:
  - `redis.ts`: the wiring;
  - `mails.ts`: the queue definition, its schedules and groups;
  - `producer.ts` and `worker.ts`: the entry points;
  - `env.ts`.
  Specs go beside the files. Copy `test/redis.ts` from hono-api's pattern.
- Modify the root workspace list if needed, and the `AGENTS.md` examples table (one row).

- [ ] **Step 1: Write the failing spec.**
  - Adding a welcome mail for two tenants runs both, and at most `concurrency` run per tenant.
  - The digest schedule is listed with its next occurrence in the zone.
  - A retried job does not re-run its completed `send` step.
  - The worker closes on a signal with no job lost.
- [ ] **Step 2: Implement.** Keep each file short.
- [ ] **Step 3: Verify.** Run `bun run --filter queue-mails-example test` and `typecheck`, then the root green bar.
- [ ] **Step 4: Commit** `feat: Add an example that sends mails through a queue`.

---

### Task 4: Docs and metadata (the controller sends it to the documentation agents)

The documentation agents do the following:
- **The guide:** a "Benchmark" section in `queues.md`, with the numbers from `bench-output.md`, the machine and the versions, and how to rerun it. Link it from the round-trip table.
- **The README:** a pointer to the example and the benchmark. Add `queue`, `jobs`, `cron` and `worker` to `keywords` in `package.json`.
- **The roadmap:** the queue entry stays in Now, "landed, not yet released", until the effort's release moves it to Shipped. Record *Next* (rate limit per group, drain and obliterate) and *Later*, following the spec's "Not in this version".
- **`AGENTS.md`:** the `@nxgt/redis` row gains the queue (`src/queue/`, its folders, the scripts' trust and cap rules, the `groups:mode` marker, the benchmark). The examples table gets its row in Task 3.

## After the tasks

- [ ] A final review on Opus, then `documentation-auditor`. Open a PR into `feat/redis-queue` naming the four merge conditions, and merge it once green.
