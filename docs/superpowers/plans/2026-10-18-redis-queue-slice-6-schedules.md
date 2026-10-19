# Queue slice 6 (schedules) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recurring jobs. A schedule is `{ cron, timezone?, data }` or `{ every, data }`. Static schedules are declared in `defineQueue({ schedules })`, and runtime ones go through `q.schedules.upsert/remove/list`. The queue's workers fire each occurrence exactly once, across processes.

**Architecture:**
- **The cron parser and time-zone arithmetic** are pure TypeScript in a new subject folder, `src/queue/schedule/`, with no dependency and no Redis.
- **Storage** is the spec's `schedules` zset plus one `schedule:<id>` hash per schedule.
- **Firing.** The claim reply gains the ids of due schedules, so finding them costs no extra round trip. The worker computes each one's next occurrence and runs FIRE, which adds the occurrence and moves the score only if the score is still the one it read. Two processes therefore cannot both fire one occurrence.
- **SYNC.** The first worker of a queue in a process runs SYNC once, making the definition's schedules the stored ones.

**Tech Stack:** Bun 1.4.3 `RedisClient`, Lua (Redis 7.4), `Intl.DateTimeFormat`, zod 4, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-18-redis-queue-design.md`. The relevant parts are "Recurring jobs", "Storage" (`schedules`, `schedule:<id>`, occurrence ids), "Scripts" (FIRE, SYNC, CLAIM's `next`), "The worker" (Schedules), and "Decisions" ("Runtime schedules: yes, in Redis"; "Schedules removed from `defineQueue`: removed at worker start").

## Global Constraints

- **Rules from slices 1–5 still bind:**
  - TSDoc on every export, and no import extensions.
  - Files ≤ 250 lines and functions ≤ 80. `types.ts` (230), `inspect.ts` (245) and `settle.ts` (218) must not grow: new code goes in files of its own, under `src/queue/schedule/`.
  - Use `rejection()`, never `expect(p).rejects`.
  - Scripts trust only state they could have written. Every loop has a cap. Replies report shapes, never values.
  - Commits use the unscoped prefixes `feat:`, `fix:`, `chore:` and `docs:`.
  - Admin calls pass through after `redis.close()`. That includes `schedules.upsert`, `remove` and `list`.
- **Cron format:**
  - Five fields: minute (0–59), hour (0–23), day of month (1–31), month (1–12 or `jan`–`dec`) and day of week (0–7 or `sun`–`sat`, where 0 and 7 are both Sunday). Names are case-insensitive.
  - Each field accepts `*`, `a`, `a-b`, `*/n`, `a-b/n`, `a/n` (meaning `a-max/n`) and comma lists of these.
  - When both day of month and day of week are restricted (neither is `*`), a day matches if either does, as in Vixie cron.
  - No macros (`@daily`), no seconds, no `L`, `W` or `#`.
- **A cron that can never match is refused.** The check is exact, not a search: it applies when day of month is restricted and day of week is `*`, and refuses the cron when no listed month has any listed day (February counts 29). An example is `0 0 31 2 *`.
- **Time zones:**
  - `timezone` is any IANA name that `Intl.DateTimeFormat` accepts, and defaults to `'UTC'`. A name `Intl` refuses is refused with the name in the message.
  - Wall time is converted to an instant through the zone's offset, read with a cached `Intl.DateTimeFormat` per zone (`formatToParts`, `hourCycle: 'h23'`).
- **Next occurrence, `nextAfter(cron, zone, t)`:** the first instant `> t` whose wall time matches.
  - A wall time that does not exist (spring forward) runs at the first instant after the gap.
  - A wall time that happens twice (fall back) runs once, at its first instant. During the second pass, a wall time whose first instant is `≤ t` is skipped.
  - The search walks days forward from `t`'s wall date. It is bounded by 1 500 days, which a cron that passed the check above always meets (a leap day at worst). Reaching the bound is a bug: throw an `Error` saying so.
- **`every`:**
  - A `Duration` of at least 1 000 ms.
  - The first occurrence is at `upsert` (or SYNC) time plus `every`.
  - After firing occurrence `due`, the next is the first `due + k × every` that is greater than now, for whole `k ≥ 1`. An outage fires the missed occurrence once, never one per missed tick, and the grid keeps its phase.
- **Schedule ids** follow the job-id name rule (`src/queue/name.ts`: 1–256 characters, no braces), with no `:` either. The occurrence id is `schedule:<id>:<due ms>`.
- **Caller-given job ids may not start with `schedule:`.** Add this to the `id` rule in `resolveAdd`, so a caller can never collide with an occurrence: `id cannot start with "schedule:", which names scheduled occurrences`.
- **`data`** is parsed by the queue's schema when the definition is made, for static schedules, and at `upsert`. A refusal is a `QueueError` `INVALID` naming the queue and the schedule id, never the data. The parsed value is stored as JSON. FIRE copies it as it is, and the claim parses it again, as for any job.
- **Storage:**
  - `schedules` is a zset, id → ms of the next occurrence.
  - `schedule:<id>` is a hash with `kind` (`cron` or `every`), `spec` (the cron text, or `every` in ms), `timezone` (cron only), `data` (JSON) and `origin` (`definition` or `runtime`).
  - Keys go through `queueKeys`: `schedules`, and `schedule` as a prefix for scripts.
- **Who owns which schedule:**
  - `upsert` refuses an id whose stored `origin` is `definition`, and SYNC never touches `origin=runtime`.
  - The `upsert` refusal is decided in the script. It surfaces as a `TypeError` after the round trip: `schedules.upsert on "<queue>": "<id>" belongs to the definition; change it in defineQueue`. A static schedule id that matches a stored runtime one is taken over by SYNC, since the definition wins, and the docs say so.
- **Firing:**
  - Occurrences are added as jobs with the definition's `attempts` and `timeout` and priority 0, through the same Lua as ADD. Extract that Lua into an `add_job` function used by both; ADD's behaviour stays unchanged.
  - Schedules fire while the queue is paused, and their jobs wait in `ready` until `resume()`.
  - With no worker running, nothing fires. Document that.
- **Round trips:**
  - CLAIM is still 1. Its reply carries at most 20 due schedules, each `{id, kind, spec, timezone, due}`.
  - FIRE is 1 per due schedule.
  - SYNC is 1, once per queue per process.
  - `upsert` and `remove` are 1 each.
  - `list({ offset, limit })` is 1. `limit` defaults to 100 and is at most 1 000, as `q.list` is.
- **The claim's `next`** is the minimum of the delayed head and the schedules head, as the spec says. The 5 s cap stays.

## Review Focus

- **DST in both directions.**
  - Europe/Paris on 2026-03-29: `30 2 * * *` runs at 03:00 local (01:00Z).
  - Europe/Paris on 2026-10-25: `30 2 * * *` runs once, at 00:30Z, not again at 01:30Z.
  - Australia/Lord_Howe, whose daylight shift is 30 minutes: the same rules hold.
- **Two processes firing:** two workers on two clients, one schedule due. Exactly one occurrence job exists, and the score has moved to the next occurrence.
- **An outage:** a schedule whose stored next is 3 ticks in the past fires one occurrence. Its new score is the first future tick on its grid.
- **Ownership:** `upsert` on a definition's id is refused. A runtime schedule survives a SYNC. A static schedule removed from the definition is gone after the next first worker start.
- **A schedule against a changed schema:** an occurrence whose stored data no longer passes the schema goes to `failed` as `INVALID`, as any job does, and the schedule keeps firing.

---

### Task 1: The cron parser and the next occurrence in a time zone (pure)

**Files:**
- Create: `packages/redis/src/queue/schedule/cron.ts`, with `parseCron(text: string): Cron` (or a `TypeError` naming the field and the reason) and `matchesDay` and `matchesTime` helpers. A `Cron` is the five sets, plus the two "restricted" flags.
- Create: `packages/redis/src/queue/schedule/zone.ts`, with `checkZone(name): void`, `wallOf(ms, zone): Wall` and `instantsOf(wall, zone): { first: number; inGap: boolean }`. When the wall time is in a gap, `first` is the instant just after it.
- Create: `packages/redis/src/queue/schedule/next.ts`, with `nextAfter(cron: Cron, zone: string, t: number): number` and `nextEvery(due: number, everyMs: number, now: number): number`.
- Test: `schedule/cron.spec.ts`, `schedule/zone.spec.ts`, `schedule/next.spec.ts`.

- [ ] **Step 1: Write the failing tests.**
  - **Parsing:** every form above. Name case. Refusals give a message naming the field, for out of range, a step of 0, a reversed range, an unknown name, six fields, a macro, and an impossible date (`0 0 31 2 *`, `0 0 30 2 *`, `0 0 31 4,6,9,11 *`). `0 0 29 2 *` is accepted.
  - **Vixie OR:** `0 0 13 * 5` matches every 13th and every Friday.
  - **nextAfter in UTC:** minute and hour rollover, month end, leap day (`0 0 29 2 *` from 2026-03-01 gives 2028-02-29T00:00Z), and `t` exactly on a match gives the next one.
  - **DST:** the Review Focus cases, plus America/New_York (2026-03-08 and 2026-11-01) and a zone with no DST (Asia/Tokyo).
  - **Fall back with `*/15 1 * * *`** in America/New_York on 2026-11-01: 01:00, 01:15, 01:30 and 01:45 run once each, in the first pass only.
  - **nextEvery:** on the grid, after an outage of 3 ticks, and with `now` exactly on a tick.
  - **checkZone:** refuses `'Mars/Olympus'`, and accepts `'UTC'` and `'Europe/Paris'`.
- [ ] **Step 2: Run the tests and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and watch them pass.** Then run a mutation pass on the OR rule, the gap rule, the fold skip and the impossible-date check, and kill each mutant.
- [ ] **Step 5: Commit** `feat: Parse cron and find its next occurrence in a time zone`.

---

### Task 2: The schedule scripts

**Files:**
- Modify: `scripts/add.ts`, extracting `ADD_JOB_FN`, the Lua `add_job(...)` that writes one job. ADD's per-job loop calls it. ADD's behaviour stays byte for byte, and its specs pass unchanged.
- Create: `scripts/schedule.ts`, holding these scripts:
  - **`UPSERT`**: refuses `origin=definition` and answers `'definition'`; otherwise writes the hash with `origin=runtime` and ZADDs next.
  - **`UNSCHEDULE`**: refuses `origin=definition` the same way; otherwise deletes the hash and the ZREM. It answers 1, 0 for none, or `'definition'`.
  - **`FIRE`**: reads the stored hash. It adds the occurrence `schedule:<id>:<due>` with `add_job` only if `ZSCORE schedules id == due` and the hash is sound, then ZADDs `next`. It answers 1 when fired and 0 otherwise.
  - **`SYNC`**: takes the definition's list (`id, kind, spec, timezone, data, next` each). It upserts each one with `origin=definition`. Where the stored hash has the same `kind`, `spec` and `timezone`, it keeps the stored score; otherwise it sets `next`. It deletes every `origin=definition` hash whose id is not in the list, and leaves runtime ones alone. Cap it at 1 000 schedules per call.
  - **`SCHEDULES`**: the list, paginated.
- Modify: `queue/keys.ts`, adding `schedules` and `schedule` (the prefix).
- Modify: `scripts/claim-body.ts`, so the claim also returns up to 20 due schedules (`ZRANGEBYSCORE schedules -inf now LIMIT 0 20`, each with `kind`, `spec`, `timezone` and score), and `next` takes the schedules head into account. Add `schedules` at KEYS[11] in `scriptKeys`. Extend `parseClaimReply` with `due: {id, kind, spec, timezone, due}[]`.
- Test: `scripts/schedule.spec.ts`, `scripts/claim.spec.ts` (new cases only, or a new `scripts/claim-due.spec.ts` if claim.spec would pass 250 lines), and `scripts/stored-state.spec.ts` (new cases).

- [ ] **Step 1: Write the failing tests.**
  - FIRE fires once: a second FIRE with the same `due` answers 0 and adds nothing. FIRE with a stale `due` answers 0.
  - FIRE copies `data`, uses the definition's attempts and timeout, and leaves a wake token, as ADD does.
  - UPSERT and UNSCHEDULE refuse `origin=definition`. SYNC adds, updates (keeping the score when nothing changed, and resetting it when the spec changed), removes static schedules that are gone, and leaves runtime ones.
  - The claim reports due schedules, capped at 20, and `next` covers the schedules head.
  - A schedule hash the scripts could not have written (a missing `kind`, an unknown `kind`) is skipped by the claim's due list and refused by FIRE, never repaired.
  - The ADD specs pass unchanged after the extraction.
- [ ] **Step 2: Run the tests and watch them fail.** **Step 3: Implement.** **Step 4: Run the tests and watch them pass.** Then run a mutation pass on FIRE's score check, SYNC's origin filter and UPSERT's refusal, and kill each mutant.
- [ ] **Step 5: Commit** `feat: Store, sync and fire schedules in scripts`.

---

### Task 3: The API, `defineQueue({ schedules })` and `q.schedules`

**Files:**
- Create: `schedule/define.ts`, with `resolveSchedules(input, schema, call, name)`. It checks each schedule: the id, exactly one of `cron` or `every`, `timezone` only with `cron`, the parsed cron, the zone, `every` ≥ 1 s, and `data` through the schema. It returns frozen `ScheduleDefinition`s.
- Create: `schedule/handle.ts`, holding `schedules.upsert(id, schedule)`, `remove(id)` and `list({ offset, limit })` for `BoundQueue`.
- Create: `schedule/types.ts`, holding `Schedule<S>` (the union `{ cron, timezone?, data } | { every, data }`), `ScheduleView` (`{ id, cron? | every?, timezone?, data, origin, next: Date }`) and `QueueSchedules<S>`. Export them from `src/index.ts`.
- Modify: `define-queue.ts` (the option) and `types.ts` (one line each: `QueueInput.schedules?` and `BoundQueue.schedules`; the types live in `schedule/types.ts`). In `bind-queue.ts`, wire the handle.
- Modify: `encode.ts`, adding the `schedule:` prefix refusal for `id`.
- Test: `schedule/define.spec.ts`, `schedule/handle.spec.ts`, `test/types/queue.ts` and `test/declarations/queue.ts`.

- [ ] **Step 1: Write the failing tests.**
  - Every `defineQueue` refusal, with its exact message: a cron with an `every`, neither, `timezone` with `every`, a bad zone, `every: '500ms'`, a bad id, and data the schema refuses (`QueueError` `INVALID`).
  - `upsert` validates the same way before any round trip, and answers the `TypeError` for a definition's id.
  - `upsert` then `list` shows the schedule with `origin: 'runtime'` and `next` as a Date. An `upsert` of the same id replaces it and recomputes `next`.
  - `remove` answers `NOT_FOUND` for none, as `q.remove` does.
  - All three pass through after `redis.close()`.
  - `add(data, { id: 'schedule:x:1' })` is a TypeError.
  - Types: `data` is checked against the schema type. `{ cron, every }`, `{ every, timezone }` and a duration typo are errors.
- [ ] **Step 2: Run the tests and watch them fail.** **Step 3: Implement.** **Step 4: Run the tests and watch them pass.**
- [ ] **Step 5: Commit** `feat: Declare schedules and manage them at run time`.

---

### Task 4: The worker fires, and SYNC at start

**Files:**
- Create: `worker/fire.ts`, holding `fireDue(context, due[])`. For each due schedule it computes the next occurrence, with `nextAfter` for a cron (from its `due`) or `nextEvery`, and runs FIRE. A schedule whose `spec` no longer parses is logged through the worker's `error` event and its FIRE skipped, so it stays due and is not removed. The worker never throws out of its loop.
- Modify: `worker/loop.ts` and `worker/run-job.ts`, so the claim's `due` goes to `fireDue`. Firing runs between the claim and the wait, so a busy worker fires too: a settle-and-claim reply carries `due` like a claim does.
- Create: `worker/sync.ts`. On the first `work()` of a queue in a process, SYNC runs once before the first claim. Memoise it per (client, queue storage name). Computing the definition's `next` values happens here, with `now` from the client's clock. That is fine: SYNC keeps stored scores when nothing changed, and a skew only shifts a first occurrence.
- Modify: the spec, "The worker" › Schedules, with the due list in the claim reply and the 20 cap, and "Scripts" FIRE and SYNC with the ownership rules.
- Test: `worker/schedules.spec.ts`.
- Changeset: `.changeset/redis-queue-schedules.md`, `'@nxgt/redis': minor`.

- [ ] **Step 1: Write the failing tests.**
  - An `every: '1s'` runtime schedule fires about every second on one worker. Assert the occurrence ids `schedule:<id>:<ms>` lie on the grid.
  - Two workers on two clients (`useClients`) both see the due schedule, and exactly one occurrence exists (Review Focus).
  - An outage: seed the score 3 ticks in the past. One occurrence is fired, and the new score is the first future grid tick (Review Focus).
  - SYNC at start: a static schedule appears with `origin: 'definition'`. A static schedule from an older definition, stored by hand with `origin=definition`, is removed. A runtime one survives.
  - A changed schema: the occurrence goes to `failed` as `INVALID`, and the next occurrence still fires (Review Focus).
  - A paused queue still fires. The job waits in `ready` and runs after `resume()`.
  - Round trips: one FIRE per occurrence, and no extra CLAIM (count scripts).
- [ ] **Step 2: Run the tests and watch them fail.** **Step 3: Implement.** **Step 4: Run the tests and watch them pass.** Run the worker specs 20× in a row.
- [ ] **Step 5: Green bar:** `bun run check && bun run typecheck && bun run build && bun run test && bun run verify:artifacts`.
- [ ] **Step 6: Commit** `feat: Fire schedules from the workers, and sync the definition's at start`.

**Docs** (the controller sends these to the documentation agents after Task 4):
- Guide: a "Recurring jobs" section in `queues.md` covering:
  - cron syntax and its OR rule;
  - time zones and DST, with the Paris examples;
  - `every` and its grid;
  - static versus runtime schedules, and their ownership;
  - occurrence ids;
  - outages fire once;
  - nothing fires without a worker;
  - paused queues still fire.
- README rows; the troubleshooting entries for every new refusal and the "belongs to the definition" TypeError; the roadmap.

## After the tasks

- [ ] A final review on Opus (`nxgt-review:code-reviewer`) until `ready: true`, and `nxgt-docs:documentation-auditor` until `ok: true`.
- [ ] A PR into `feat/redis-queue` that names the four merge conditions; merge it once green.
