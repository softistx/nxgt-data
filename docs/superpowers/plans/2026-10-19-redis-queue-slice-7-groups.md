# Queue slice 7 (groups) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `add(data, { group })` with a per-group `concurrency` and fair round-robin between groups. Within a group, the most urgent job goes first. A group never starves another, whatever its priorities.

**Architecture:**
- **`ready` stays the index of every ready job**, so counts, `list`, `get`, wakes, pause, rate and RESUME keep working unchanged.
- **A grouped queue** (one whose definition declares `groups`) also keeps each ready job in its group's zset, `group:<g>:ready`. Jobs without a group sit in the default group, whose name is the empty string.
- **The claim serves groups in round-robin order** through the list `groups:ready`, which holds the groups that have ready jobs and a free slot. A set, `groups:queued`, keeps that list free of duplicates.
- **`group:<g>:active` counts the group's running jobs.** It goes down exactly when the job leaves `active`.
- **A queue without `groups` takes none of these paths and writes no group key**, so its behaviour and its costs do not change.

**Tech Stack:** Bun 1.4.3 `RedisClient`, Lua (Redis 7.4), zod 4, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-18-redis-queue-design.md`, sections "Groups (slice 7)", "Storage" (`groups:ready`, `group:<g>:ready`, `group:<g>:active`) and "Decisions" ("Groups × priority: round-robin, priority within a group"). Task 4 amends the spec. `ready` becomes a global index rather than "the default group", which is possible because nothing is released yet.

## Global Constraints

- **Rules from slices 1–6 still bind:**
  - TSDoc on every export, and no import extensions.
  - Files ≤ 250 lines and functions ≤ 80, Lua functions included, measured by hand.
  - `claim-body.ts` (248), `inspect.ts` (245), `types.ts` (241), `schedule.ts` (228) and `settle.ts` (218) must not grow past 250. Task 1 makes room first.
  - Use `rejection()`, never `expect(p).rejects`.
  - Scripts trust only state they could have written. Every loop has a cap. Replies report shapes, never values.
  - Commits use the unscoped prefixes `feat:`, `fix:`, `chore:` and `docs:`.
- **The option:**
  - `defineQueue({ groups: { concurrency? } })`. `concurrency` is a whole number ≥ 1; when it is absent, groups have no cap and only round-robin applies. The value is frozen.
  - `add(data, { group })` and `addMany` items take `group`, a string following the name rule (`src/queue/name.ts`: 1–256 characters, no braces). The group name must not contain `:` either.
  - `group` on a queue whose definition has no `groups` is a `TypeError` raised before any round trip: `add on "<queue>": group needs groups in defineQueue`.
  - Schedule occurrences have no group.
- **The invariants, on a grouped queue, after every script:**
  1. id ∈ `ready` ⇔ id ∈ `group:<g>:ready`, where `g` is the hash's `group` or `''`.
  2. `group:<g>:active` = the number of ids in `active` whose `group` is `g`. Only named groups are counted; the default group has no cap and no counter.
  3. `g` ∈ `groups:queued` ⇔ `g` is in the `groups:ready` list, exactly once.
  4. If `group:<g>:ready` is non-empty and `g` has a free slot, then `g` ∈ `groups:queued`. The default group always counts as having a free slot.
  - Any of these may be stale only for a group the scripts could not have written. The claim tolerates a stale list entry by dropping it and moving on, within its cap.
- **One Lua module, `scripts/groups.ts`, owns every group write.**
  - It exports `GROUP_FN` with `ready_add(id, score, g)`, `ready_rem(id, g)`, `slot_taken(g)`, `slot_freed(g)`, `rr_push(g)` and `rr_take()`.
  - Every script that adds to or removes from `ready`, or removes from `active`, goes through these helpers when the queue is grouped. That covers ADD, FIRE, promotion and reclaim in the claim, COMPLETE, FAIL, CANCEL, REMOVE, RETRY, and the debounce move.
  - `slot_freed` runs exactly when `ZREM active id` returns 1.
- **Keys and arguments:**
  - Keys go through `queueKeys`: `groupsReady` (list), `groupsQueued` (set), and `group`, the prefix for scripts (`queue:{<name>}:group:`).
  - `scriptKeys` appends `groupsReady` at KEYS[12] and `groupsQueued` at KEYS[13].
  - Each grouped-capable script gets two ARGVs, `grouped` (`'1'` or `'0'`) and `concurrency` (`0` meaning no cap), plus the group prefix.
- **Claiming on a grouped queue:**
  - Up to `n` times (after pause and rate admission), it runs `rr_take()`: LPOP `groups:ready` and SREM `groups:queued`.
  - It ZPOPMINs that group's zset, ZREMs the id from `ready`, and runs `slot_taken(g)`.
  - If the group still has jobs and a free slot, it runs `rr_push(g)` to the tail. The next group then goes next, which is the round-robin.
  - An empty or full group taken from the list is dropped. The loop is capped at `2n + 10` takes.
  - Wake and `next` rules: "has claimable work" means `LLEN groups:ready > 0`, not `ZCARD ready > 0`. A grouped queue whose ready jobs all sit in full groups leaves no wake token, so workers do not spin. A settle that frees a slot pushes the group and a wake token.
- **Round trips are unchanged:** `add` 1, claim 1, and a busy worker 1 per job.

## Review Focus

- **Fairness against priorities:** group A holds 100 jobs at priority 0 and group B holds 1 job at priority 1000. With concurrency 1 on one worker, B's job is among the first two claimed.
- **Concurrency across workers:** with `concurrency: 2`, four workers on two clients and ten jobs in group A, at most 2 A jobs ever run at once. Measure it with a counter inside the handler. Meanwhile group B's jobs still run.
- **Every way out of `active` frees the slot exactly once:** complete, fail with a retry, fail for good, a lapsed lease that gets reclaimed, a cancel while running, and a late settle after a reclaim, which must not free twice. Check the counter after each.
- **The invariants hold after a random mix of operations:** add, addMany, claim, complete, fail, cancel, remove, retry, debounce, pause/resume, and lapse. Run a seeded sequence of a few hundred operations against a real Redis, then check all four invariants.
- **No spin when every ready job sits in a full group:** two idle workers while group A is full stay idle (count CLAIMs over 1 s). When A's running job completes, a waiting worker claims at once.

---

### Task 1: Make room first, with no spec touched

**Files:**
- Create: `scripts/claim-steps.ts`. Move the claim body's reclaim and promote steps there, as their own Lua functions (`reclaim(now)` and `promote(now)`), plus `next_wait`.
- Modify: `scripts/claim-body.ts`, so `CLAIM_FN` concatenates them. The Lua that reaches Redis stays text-equivalent apart from the function boundaries, and its behaviour stays identical.
- Keep `claim-body.ts` well under 200 lines.

- [ ] **Step 1:** Make the moves. **Step 2:** `bun test src/queue` from packages/redis; every spec passes unchanged and none is edited. **Step 3:** Run the green bar. **Step 4:** Commit `chore: Split the claim's reclaim and promote steps out`.

---

### Task 2: Grouped add, claim and settle

**Files:**
- Create: `scripts/groups.ts` (`GROUP_FN`, as in Global Constraints).
- Modify: `scripts/add.ts` (`add_job` writes `group` on the hash and calls `ready_add` when grouped), `scripts/claim-body.ts` and `claim-steps.ts` (promote, reclaim and the round-robin pop), `scripts/settle.ts` (COMPLETE and FAIL run `slot_freed` when ZREM active returns 1, then `rr_push` and a wake when the group became claimable), `scripts/claim.ts` (`scriptKeys`), and `queue/keys.ts`.
- Modify: the client callers, which pass `grouped`, `concurrency` and the prefix. For now take them from a definition field `groups?: { concurrency: number }` (0 = no cap). Task 4 adds the option that sets it, so specs here build the definition by hand.
- Test: `scripts/groups.spec.ts`, `scripts/groups-claim.spec.ts`, plus `test/group-state.ts`, a helper that checks the four invariants and is used by every group spec from now on.

- [ ] **Step 1: Write the failing tests.**
  - Round-robin: groups A, B and C with 3 jobs each, one claim at a time. The order alternates A, B, C, A, …
  - Within a group, priority comes first.
  - Fairness (Review Focus).
  - Concurrency: `concurrency: 1`, two A jobs. The second claim gets nothing from A but takes B's job.
  - Complete frees the slot and puts A back in the list with a wake. Fail with a retry frees it too, and the job goes to `delayed`; when it is promoted later, it comes back to A's zset.
  - Reclaim frees the slot once, and a late COMPLETE of the reclaimed job frees nothing.
  - The default group takes its turn and has no cap.
  - An ungrouped queue writes no `group:*` or `groups:*` key (SCAN the test Redis in the spec).
  - A stale entry in the list (a group with an empty zset, or a full group) is dropped without looping. Seed the list by hand.
  - No spin while all ready jobs are in full groups: no wake token, and `next` is not 0.
  - The invariant helper passes after each of the above.
- [ ] **Step 2: Run the tests and watch them fail.** **Step 3: Implement.** **Step 4: Run the tests and watch them pass.** Then run a mutation pass: drop `slot_freed`, free on every ZREM regardless of the reply, skip `rr_push` after a pop, push without the dedupe set, and treat ZCARD ready as claimable. Kill each mutant.
- [ ] **Step 5: Commit** `feat: Claim grouped jobs in round-robin under a per-group concurrency`.

---

### Task 3: Every other transition keeps the groups right

**Files:**
- Modify: `scripts/cancel.ts` (a waiting job leaves its group zset; an active one frees its slot), `scripts/admin.ts` (REMOVE and RETRY), `scripts/add.ts` (the debounce move out of `ready`), and `scripts/schedule.ts` (FIRE adds through `add_job`, so a default-group occurrence lands in `group::ready`). Use only `GROUP_FN` helpers.
- Test: `scripts/groups-transitions.spec.ts`, and `scripts/groups-fuzz.spec.ts`, which runs the seeded operation mix from the Review Focus and checks the invariants after each step. It is deterministic: a fixed seed, and its operations logged on failure.

- [ ] **Step 1: Write the failing tests**, one per transition, each checking the invariants: cancel waiting, cancel active, remove waiting, retry from failed, a debounce of a waiting grouped job (it moves to `delayed` and leaves its group zset), and FIRE on a grouped queue. Then the fuzz spec, with 300 operations and seed 42.
- [ ] **Step 2: Run the tests and watch them fail.** **Step 3: Implement.** **Step 4: Run the tests and watch them pass.** Run the fuzz spec with 5 different seeds once, and report them. Then run a mutation pass on the cancel-active `slot_freed` and the debounce `ready_rem`, and kill each mutant.
- [ ] **Step 5: Commit** `feat: Keep groups right through cancel, remove, retry, debounce and schedules`.

---

### Task 4: The API, the worker specs and the spec amendment

**Files:**
- Create: `queue/group.ts`, holding `resolveGroups(input, call, name)` for the definition, and the `group` checks for `add`, called from `resolveAdd`.
- Modify: `define-queue.ts` (the option), `types.ts` (at most one line for `QueueInput.groups` and one for `AddOptions.group`; put a `QueueGroups` type in `flow-types.ts`), `view.ts` (`JobView.group?: string`), and `src/index.ts`.
- Modify: the spec ("Groups", "Storage" rows, "Scripts" CLAIM/COMPLETE/FAIL), with `ready` as the global index, the round-robin list, the invariants, and the wake rule.
- Test: `queue/group.spec.ts` (refusals and messages), `worker/groups.spec.ts` (Review Focus: concurrency across workers on two clients, no spin with a full group, and a freed slot waking a worker at once), `test/types/queue.ts`, and `test/declarations/queue.ts`.
- Changeset: `.changeset/redis-queue-groups.md`, `'@nxgt/redis': minor`.

- [ ] **Step 1: Write the failing tests.**
  - Each refusal gives its exact message with no round trip: `group` without `groups`, a bad group name, `concurrency` 0 or 1.5.
  - `get(id).group`.
  - Types: `add(data, { group: 1 })` is an error.
  - The worker specs listed above.
- [ ] **Step 2: Run the tests and watch them fail.** **Step 3: Implement.** **Step 4: Run the tests and watch them pass.** Run the worker specs 20× in a row.
- [ ] **Step 5: Green bar:** `bun run check && bun run typecheck && bun run build && bun run test && bun run verify:artifacts`.
- [ ] **Step 6: Commit** `feat: Group a queue's jobs, with fair turns and a per-group concurrency`.

**Docs** (the controller sends these to the documentation agents after Task 4):
- Guide: a "Groups" section in `queues.md`. It covers:
  - the use: one tenant cannot hold up the others;
  - round-robin with priority inside each group;
  - the default group;
  - `concurrency`;
  - what frees a slot;
  - how groups interact with the rate limit, pause and debounce;
  - the cost: a grouped queue writes a second index for each job.
- README rows; the troubleshooting entries for the new refusals; the roadmap.

## After the tasks

- [ ] A final review on Opus (`nxgt-review:code-reviewer`) until `ready: true`, and `nxgt-docs:documentation-auditor` until `ok: true`.
- [ ] A PR into `feat/redis-queue` that names the four merge conditions; merge it once green.
