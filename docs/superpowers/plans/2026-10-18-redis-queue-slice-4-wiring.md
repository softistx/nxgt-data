# Queue slice 4 (wiring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `openRedis(defineRedis({ uri, prefix, queues: { mails } }))` gives `redis.queues.mails`, the bound queue under the deployment's prefix; `redis.close()` closes every worker it started, rejects what still waits, and refuses new work with `QueueError` `CLOSED`.

**Architecture:**
- The configuration learns a fifth kind, `queues`, detected by shape like the others and checked by the same clash rule.
- The queue is **not** bound through `underPrefix`. An internal `bindQueueWith(client, definition, { prefix, life })` takes the caller's definition unchanged, builds the keys from `<prefix>:<name>`, and builds `job.key` from separate parts.
- Each Redis object owns one `QueueLife`, a data object. It tracks the workers started through it and the `finished()` calls still waiting. `redis.close()` closes in two phases: first the workers (with a grace), then the waits, then subscriptions and connections, as today.

**Tech Stack:** Bun 1.4.3 `RedisClient`, zod 4, `bun:test`, `tsc` type tests.

**Spec:** `docs/superpowers/specs/2026-10-18-redis-queue-design.md`. The parts that bind here: "Shape of the API" (the wired form), Storage (`queue:{<name>}:<part>`, prefix in front of the name when wired), "The worker" (`redis.close()` closes every worker still open first), Errors (`CLOSED`), and Slices item 4. Slices 1–3 are merged on `feat/redis-queue` (de48afc). Their ledgers are in `.superpowers/sdd/` in the integration worktree.

## Decisions

These were open when the slice started. They are settled here from the code, and each task relies on them.

1. **`redis.queues.<key>` is the object `bindQueue` returns** (`BoundQueue<S, R>`), built lazily by `at()` and memoised per instance and key, like the other scopes.
   - It runs on `instance.client`. Reading it sends nothing.
   - The BLPOP connection is already lazy: `loop.ts` duplicates the client on the first idle wait (`context.waiter ??=`).
   - The shared subscriber is already lazy too: it opens on the first `listen`, which means the first `work()` (`hearCancels`) or the first `finished()`.
   - `openRedis` does nothing for queues beyond the checks.
2. **The definition is never copied.** `redis.queues.mails.definition` is the caller's `mails` itself (`toBe`). `underPrefix` would put a `:` into a name that `defineQueue` refuses one in.
   - The prefix is a new field, `BoundQueue.prefix: string | undefined`. It is `undefined` when the queue is bound by hand, the same convention as `InstanceScope.prefix`.
   - Messages and `QueueError.queue` keep the definition's name (`add on "mails": …`). This departs on purpose from the guards, whose wired `definition.name` carries the prefix.
3. **Storage name and `job.key`:**
   - Storage name: `prefix === undefined ? name : `${prefix}:${name}``, so the keys are `queue:{app:prod:mails}:<part>`, as the spec says. Without a prefix, the wired keys are byte-for-byte those of `bindQueue`.
   - `job.key(step)`: `[prefix, name, id, step]`, joined with `:` after dropping an `undefined` prefix. That gives `app:prod:mails:a:b:send`, or `mails:a:b:send` by hand.
   - Within one deployment the prefix is a constant leading segment, the name and the step hold no `:`, so the id is everything in between.
   - Residual caveat, documented and not enforced: two deployments that hand keys to **one** downstream provider need prefixes that are not segment-prefixes of each other. With `app` and `app:x`, queue `x` with job `y:1` and queue `y` with job `1` both give `app:x:y:1:<step>`.
4. **A prefix holding `{` or `}` is refused when the instance wires a queue.** The storage name sits inside the hash tag, and a brace would split it. Instances without queues keep accepting any non-empty prefix, so nothing breaks.
5. **Name clashes:** queues join the key group of `refuseClash`, with the kind label `'queue'`.
   - Group: `['cache', …], ['rate limit', …], ['idempotency', …], ['queue', …]`. Channels stay alone.
   - The two existing messages apply unchanged:
     - `<where> wires the queue named "<name>" twice, under "<a>" and "<b>". They would share every key in Redis. …`
     - `<where> wires the <kind> "<a>" and the queue "<b>" under one name, "<name>". …`
   - The same definition under two keys really shares every key. A cache and a queue with one name do not collide byte-for-byte (`mails:<k>` against `queue:{mails}:…`). They are refused anyway: the spec asks for it, and one name meaning one thing per deployment keeps logs and `job.key` readable.
   - `checkNothingWired` counts queues. Its message becomes `wires no cache, no channel, no rate limit, no idempotency and no queue.` and its specs are updated.
6. **`redis.close(options?: { grace?: Duration })`.** Today it takes nothing. `grace` is passed to every worker's `close`, and leaving it out gives the worker's own default, 30 s. A malformed `grace` rejects before anything closes: `TypeError: close: grace is a whole number of milliseconds or a string such as '10s'`. `Symbol.asyncDispose` uses the default.
   - The first call is memoised (`closing ??=`), as `Worker.close` is. A second call gets the same promise whatever it passes, so close stays idempotent.
7. **Two-phase close:**
   1. **closing:** `work()` is refused, and all tracked workers close in parallel (`Promise.allSettled`). During the grace, `add`, `addMany` and `finished` still work, so a handler in flight can fan out to another queue.
   2. **closed:** `add`, `addMany` and `finished` are refused. Every pending `finished()` rejects `CLOSED`, and `close` awaits each wait's cleanup, its unlisten included. Then the subscriptions close, then the connections (unchanged).
   - Releasing every listen closes the shared subscriber connection through its existing ref count, with nothing new in `subscriber.ts`.
   - A worker whose `close` rejected does not keep the rest open. The first such error is rethrown after the connections closed.
8. **`CLOSED` from calls:**
   - Refused with `CLOSED`:
     - `add`, `addMany` and a new `finished()`, once closed: a rejection;
     - `work`, once closing: a synchronous throw, as its `TypeError`s are;
     - a `finished()` pending at phase 2: a rejection.
   - Admin calls (`get`, `list`, `counts`, `retry`, `remove`, `cancel`, `handle.cancel`) pass through, as caches and channels do once closed. They fail with the client's own error on a connection the Redis owned and still work on a handed-in client: they are one-shot and leave nothing open. Starting something the Redis would never close is what `CLOSED` guards against.
   - Messages:
     - `add on "<queue>": the Redis it is wired on is closed`, and the same for `addMany` and `finished`;
     - `work on "<queue>": the Redis it is wired on is closing`;
     - pending: `finished on "<queue>": job "<id>" was still awaited when its Redis closed` (with `job` set).
   - A queue bound by hand has no life and never throws `CLOSED` from a call.
9. **An in-flight job at `redis.close()`** gets the worker's existing behaviour. It finishes within the grace and settles normally. Past the grace, its signal aborts with `CLOSED`, its lease stops renewing and lapses, and it is reclaimed elsewhere as one attempt. That is documented, and not changed here.

## Global Constraints

- Everything from slices 1–3 binds:
  - key layout `queue:{<name>}:<part>`;
  - durations;
  - call-time refusals read `<call> on "<queue>": …`;
  - TSDoc on every export;
  - no import extensions;
  - files ≤ 250 lines, functions ≤ 80;
  - rejections in specs are held with `test/rejection.ts`, never `expect(p).rejects`;
  - no polling a short-lived state in specs;
  - specs run against `useRedis()`.
- `bindQueue(client, definition)` keeps its public signature and behaviour. It becomes `bindQueueWith(client, definition, { prefix: undefined, life: undefined })`.
- Wiring messages keep the existing `<call>: instance "<name>" …` form (`checkInstance`'s `where`).
- No eager I/O in `openRedis` for queues: no connection, no subscriber, no script.
- The structural moves of Task 1 change no behaviour: the test count is identical before and after.
- AGENTS.md says a split is never made in the same PR as a behaviour change. If the reviewer holds that at PR level, Task 1 ships as its own PR into `feat/redis-queue` first.
- Commit prefixes from AGENTS.md. Messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A worker running when `redis.close()` is called.** A job that ends within the grace completes and `close` resolves after it. A job that ignores its signal past the grace is aborted `CLOSED`, and `close` still resolves; its lease lapses and is reclaimed, which is the documented behaviour, never a silent hang. → Task 5.
- **A handler that adds to another wired queue during the grace.** The add succeeds (phase 1), and the same add after `close` resolved is `CLOSED`. → Task 5.
- **`finished()` pending across `close()`.** It rejects `CLOSED` and never hangs, and the shared subscriber connection is gone afterwards: `CLIENT LIST` is back to its baseline on a handed-in client. → Tasks 4 and 5.
- **Two Redis objects, two prefixes, one definition.** The keys are separate, a worker on one never runs the other's job, closing one leaves the other's `finished()` and worker working, and the definition is untouched. → Task 5.
- **A prefix holding `:`.** `app:prod` with job id `a:b` gives `job.key('send') === 'app:prod:mails:a:b:send'`. A prefix holding a brace is refused when queues are wired. → Tasks 2 and 3.

---

### Task 1: Make room (moves only)

Four files this slice grows would pass 250 lines: `wiring/types.ts` (231), `wiring/wire.ts` (187 + close phases), `wiring/config/checks.ts` (210) and `queue/handle.ts` (243). Move code without changing it.

**Files:**
- Create: `packages/redis/src/wiring/scope-types.ts`. It receives `PayloadOf`, `BoundChannel`, `CacheScope`, `ChannelScope`, `LimitParams`, `LimitScope` and `IdempotencyScope` from `wiring/types.ts`, which re-exports the public ones, so `src/index.ts` is unchanged.
- Create: `packages/redis/src/wiring/close.ts`. It receives `closeAll` from `wire.ts`, exported.
- Create: `packages/redis/src/wiring/config/kinds.ts`. It receives `isCache`, `isRateLimit`, `isIdempotency`, `isChannel` and `wiredOf` from `checks.ts`. Update the imports in `checks.ts` and `open-redis.ts`.
- Create: `packages/redis/src/queue/outcome.ts`. It receives `Outcome`, `Failure`, `fromMessage` and `readStored` from `handle.ts`.

- [ ] **Step 1: Record the test count.** Run `cd packages/redis && bun test src 2>&1 | tail -3` and note the pass count.
- [ ] **Step 2: Move.** Keep the TSDoc with the code it documents.
- [ ] **Step 3: Verify.** Run `bun run check && bun run typecheck` and the package tests. The pass count is identical, and every touched file is ≤ 250 lines (`wc -l`).
- [ ] **Step 4: Commit** `refactor(redis): Split the wiring's scope types, close and kinds, and the job outcome`.

---

### Task 2: `queues` in the configuration

**Files:**
- Modify: `packages/redis/src/wiring/config/kinds.ts` (add `isQueue`), `config/checks.ts` (clash group, nothing wired, prefix braces), `config/types.ts` (`QueuesOf`, `QueuesIn`, `InstanceConfig.queues`, `CheckedInstance`, `RedisConfig`)
- Create: `packages/redis/test/wiring/queues.ts`. It exports `mails` (with `result`) and `digest` (without), both `defineQueue`. Add `mails` to `test/wiring/mixed.ts`.
- Test: `packages/redis/src/wiring/config/queue-refusals.spec.ts` (new), and the message updates in `define-redis.spec.ts`, `guard-refusals.spec.ts` and `open-redis.spec.ts`.

**Interfaces:**
- Produces: `isQueue(value: unknown): value is QueueDefinition<z.ZodType, z.ZodType | undefined>`, by shape. It requires:
  - `name` string, `schema` with `safeParse`;
  - `attempts`, `lease` and `keepFailed` numbers, `backoff` an object;
  - no `key` function.

  No other kind passes it, and it passes none of theirs. `isChannel` already refuses it (`lease` is a number).
- Produces: `QueuesOf<Q>` (key remap on `QueueDefinition<z.ZodType, z.ZodType | undefined>`) and `QueuesIn<C, N>`, shaped like `IdempotencyOf`/`IdempotencyIn`.
- Produces: `InstanceConfig<Ca, Ch, Li = object, Id = object, Qu = object>` with `queues?: Qu` and its TSDoc. The TSDoc says: `import * as queues from './queues'`, the keys are `queue:{<prefix>:<name>}:…`, and moving a queue bound by hand under a prefix starts new keys.
- `AnyQueue = QueueDefinition<z.ZodType, z.ZodType | undefined>` goes in `wiring/types.ts`.

- [ ] **Step 1: Write the failing tests** (`queue-refusals.spec.ts`; messages exact, as Decision 5 gives them):
  - `'an instance wiring only queues is accepted'`;
  - `'one queue under two keys is refused'`;
  - `'a queue named like a cache is refused'`, `'… like a rate limit'`, `'… like an idempotency'`;
  - `'a queue named like a channel is accepted'`;
  - `'a prefix with a brace is refused when queues are wired'`, with the message `<where> has a prefix with braces, and it wires queues; a queue's name is its keys' hash tag, so the prefix in front of it cannot hold any.`;
  - `'a prefix with a brace is still accepted without queues'`;
  - `'a module exporting a queue among caches gives the queue to queues only'` (`mixed`);
  - every refusal from `defineRedis` and again from `openRedis`, naming each.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Update the nothing-wired message and its existing specs.
- [ ] **Step 4: Run them and see them pass,** with the whole `src/wiring` suite.
- [ ] **Step 5: Commit** `feat(redis): Accept queues in defineRedis and refuse their clashes`.

---

### Task 3: A queue bound under a prefix

**Files:**
- Modify: `packages/redis/src/queue/bind-queue.ts` (`bindQueueWith`, `bindQueue` delegating), `queue/types.ts` (`BoundQueue.prefix`), `queue/worker/context.ts` (`prefix`), `queue/worker/worker.ts` (`startWorker` takes it), `queue/worker/steps.ts` (`stepKey`), `queue/worker/types.ts` (the `key` TSDoc)
- Test: `packages/redis/src/queue/prefix.spec.ts` (new)

**Interfaces:**
- Produces: `type QueueWiring = { readonly prefix: string | undefined; readonly life: QueueLife | undefined }`. `QueueLife` comes from Task 4; this task passes `undefined`, and the type may land as `life?: undefined` until Task 4 widens it.
- Produces: `bindQueueWith<S, R>(client: RedisClient, definition: QueueDefinition<S, R>, wiring: QueueWiring): BoundQueue<S, R>`. It is internal, not exported from `src/index.ts`. It calls `queueKeys(storageName)`, with the storage name from Decision 3.
- Produces: `BoundQueue.prefix: string | undefined`.
- Produces: `startWorker(client, definition, keys, handler, options: { concurrency: number; prefix: string | undefined })`, and `WorkerContext.prefix`.

- [ ] **Step 1: Write the failing tests:**
  - `'bound by hand: no prefix, the keys and job.key are unchanged'` (`job.key('send') === 'mails:<id>:send'`);
  - `'under app:prod the keys are queue:{app:prod:mails}:…'` (add one job, then `EXISTS queue:{app:prod:mails}:job:<id>`, and nothing under `queue:{mails}:`);
  - `'under app:prod, job a:b gives job.key app:prod:mails:a:b:send'` (`add(…, { id: 'a:b' })`, then a worker reads `key('send')`);
  - `'the definition is the one given, frozen and unchanged'` (`toBe`, `Object.isFrozen`, `name === 'mails'`);
  - `'two prefixes over one definition do not see each other's jobs'` (`counts()` on each);
  - `'a worker under a prefix hears a cancel on the prefixed events channel'`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** `stepKey` reads `context.prefix`.
- [ ] **Step 4: Run them and see them pass,** then the whole `src/queue` suite.
- [ ] **Step 5: Commit** `feat(redis): Bind a queue under a prefix, with job.key built from its parts`.

---

### Task 4: `QueueLife` and `CLOSED`

**Files:**
- Create: `packages/redis/src/queue/life.ts`
- Modify: `packages/redis/src/queue/bind-queue.ts` (the refusals, worker tracking), `queue/handle.ts` (the pending wait), `errors/queue-error.ts` (the `CLOSED` TSDoc)
- Test: `packages/redis/src/queue/life.spec.ts` (new). It drives `bindQueueWith` with a life made by `openLife()`.

**Interfaces:**
- Produces, in `life.ts`, data plus plain functions:
  - `interface QueueLife { state: 'open' | 'closing' | 'closed'; readonly workers: Set<Worker>; readonly waits: Set<Promise<void>>; readonly closed: AbortController }`
  - `openLife(): QueueLife`
  - `refuseClosed(life: QueueLife | undefined, call: 'add' | 'addMany' | 'finished' | 'work', queue: string): void`. It throws `QueueError` `CLOSED` per Decision 8: `work` from `closing`, the others from `closed`. Callers in async paths turn the throw into a rejection.
  - `trackWorker(life: QueueLife, worker: Worker): Worker`. It returns an `Object.create(worker, …)` whose `close` and `[Symbol.asyncDispose]` delete it from `life.workers` and then close it, the pattern `channelOf` uses for subscriptions.
  - `closeLife(life: QueueLife, grace: number | undefined): Promise<void>`. It runs both phases of Decision 7. `grace` is already checked, and `undefined` gives each worker its default.
- `waitFinished` takes `life` through `Waiting`:
  - it calls `refuseClosed` first;
  - it races `done` against `life.closed.signal` (reject `CLOSED`, with the pending message);
  - it registers in `life.waits` a promise that settles only after its `finally` ran **and** its listener's unlisten finished.

  So `listenRaced`'s `stop()` returns the unlisten promise (`Promise<void>`, never rejecting); today it returns `void`, and the existing callers ignore it.
- `failure()`'s code union gains `'CLOSED'`.
- `QueueErrorCode` `'CLOSED'` TSDoc: from `add`, `addMany`, `finished` and `work` on a queue whose Redis is closed (`work` from the moment `close` was called), and a run's `signal.reason` when its worker's grace ran out.

- [ ] **Step 1: Write the failing tests:**
  - `'add, addMany and finished reject CLOSED once closed; work throws CLOSED once closing'` (messages exact);
  - `'add still works while closing'`;
  - `'a finished pending at close rejects CLOSED with the job id'` (hold it with `test/rejection.ts`);
  - `'closeLife resolves only after every pending finished unlistened'` (on a handed-in client: count `CLIENT LIST` lines on `servers.redis.client` before the wait, during it (one more), and after `closeLife` (back to baseline));
  - `'closeLife closes every tracked worker, and a worker closed by hand leaves the set'`;
  - `'a worker whose close rejects does not keep the others open, and its error is rethrown last'` (a fake `Worker` in the set);
  - `'admin calls pass through after close'` (`counts()` on a handed-in client answers);
  - `'a queue bound by hand never throws CLOSED'`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** `handle.ts` must stay ≤ 250 lines after Task 1's move.
- [ ] **Step 4: Run them and see them pass.** Then run `life.spec.ts`, `handle.spec.ts` and `finished-races.spec.ts` 30× in a row.
- [ ] **Step 5: Commit** `feat(redis): Refuse a queue's calls with CLOSED once its life ends`.

---

### Task 5: `redis.queues` and `redis.close({ grace })`

**Files:**
- Modify: `packages/redis/src/wiring/context.ts` (`InstanceContext.queues: readonly Wired<AnyQueue>[]`, `WiringContext.queues` memo map, `WiringContext.life: QueueLife`), `wiring/open-redis.ts` (fill both), `wiring/scope.ts` (`queueScopeOf`), `wiring/wire.ts` (the `queues` getters, the memoised `close`), `wiring/close.ts` (`closeAll(ctx, grace)` runs `closeLife` first), `wiring/types.ts` and `wiring/scope-types.ts` (`QueueScope<Qu>`, `SoleQueues<C>`, `InstanceScope.queues`, `Redis.queues`, `Redis.close(options?)`)
- Test: `packages/redis/src/wiring/queues.spec.ts` (new), `packages/redis/test/types/wiring.ts`, `packages/redis/test/declarations/queue.ts`

**Interfaces:**
- Consumes: Task 2 `isQueue`/`QueuesIn`, Task 3 `bindQueueWith`, Task 4 `QueueLife`/`closeLife`.
- Produces:
  - `queueScopeOf(ctx, instance): object`, which builds `bindQueueWith(instance.client, definition, { prefix: instance.prefix, life: ctx.life })` through `at(ctx.queues, …)`;
  - `QueueScope<Qu> = { readonly [K in keyof QueuesOf<Qu>]: QueuesOf<Qu>[K] extends QueueDefinition<infer S, infer R> ? BoundQueue<S, R> : never }`;
  - `SoleQueues<C>`;
  - `InstanceScope` gains a fifth parameter `Qu = Record<never, never>` and `readonly queues: QueueScope<Qu>`;
  - `Redis<C>.queues: SoleQueues<C>`;
  - `Redis<C>.close(options?: { grace?: Duration }): Promise<void>`, with the TSDoc covering phases, grace and idempotency.

- [ ] **Step 1: Write the failing tests** (`queues.spec.ts`):
  - `'opening a Redis with queues and reading redis.queues costs nothing'`. On a handed-in client: `scriptCalls` and `CLIENT LIST` count are unchanged after `openRedis` plus reading `redis.queues.mails.definition`;
  - `'redis.queues.mails is memoised and is redis.instances.default.queues.mails'`;
  - `'wired without a prefix, the keys are bindQueue's'`;
  - `'wired under app:prod, add → work → finished round-trips, and job.key is app:prod:mails:<id>:send'`;
  - `'redis.close() waits for a running job within the grace'` (gate the handler, call `close()`, release, `finished()` resolved before `close` did);
  - `'redis.close({ grace: 50 }) aborts a job that ignores its signal with CLOSED, and resolves'` (the handler's `signal.reason.code === 'CLOSED'`);
  - `'a handler adding to another wired queue during the grace succeeds'`;
  - `'add after close rejects CLOSED; work during close throws CLOSED'`;
  - `'a finished pending across redis.close() rejects CLOSED, and CLIENT LIST is back to baseline'` (handed-in client);
  - `'an owned connection: after close, CLIENT LIST is back to baseline'` (subscriber and BLPOP duplicates gone);
  - `'two Redis objects, prefixes a and b, one definition: separate keys, closing a leaves b working'`;
  - `'close() twice returns one promise; a malformed grace rejects and closes nothing'` (`close({ grace: '10min' as never })`, then `add` still works);
  - `'[Symbol.asyncDispose] closes the workers too'`.
- **Types** (`test/types/wiring.ts`, against `test/wiring/queues.ts`):
  - `redis.queues.nope` is an error;
  - `redis.queues.mails.add({ to: 1 })` is an error;
  - a `work` handler on `mails` returning `{ messageId: 1 }` is an error;
  - `(await (await redis.queues.mails.add(d)).finished()).messageId` is a `string`, and `digest`'s `finished()` is `undefined`;
  - `defineRedis({ uri, queues, quues: {} })` is an error (Checked);
  - `queues` given under `caches` makes `redis.cache.mails` an error, and with `mixed`, `redis.channels.mails` is an error;
  - with two instances, `redis.queues` is `never` (assigned both ways, as `soleInstance` does), and `redis.instances.<n>.queues.mails` compiles;
  - `redis.close({ grace: '10min' })` is an error.
- **Declarations:** in `test/declarations/queue.ts`, add `wiredQueues = await openRedis(defineRedis({ uri, prefix: 'myapp', queues: { mails } }))`, plus an exported `wiredQueues.queues.mails` and a worker from it, mirroring `guards.ts`'s wired case.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** `closeAll(ctx, grace)` runs, in order: `closeLife`, then subscriptions, then connections. The last two sit in a `finally`, so a worker error that `closeLife` rethrows leaves the Redis closed. `wire.ts` checks `grace` with `durationMs`, rejects before memoising, and memoises the first valid call.
- [ ] **Step 4: Run them and see them pass.** Run the whole package suite, then `queues.spec.ts` 30× in a row, and `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(redis): Wire queues in openRedis, and close their workers with the Redis`.

---

### Task 6: Exports, changeset, green bar (docs listed for the controller)

**Files:**
- Modify: `packages/redis/src/index.ts` (export the types `QueueScope`, `SoleQueues`, `QueuesOf`, `QueuesIn`; `bindQueueWith`, `QueueLife` and `QueueWiring` stay internal)
- Create: `.changeset/<name>.md` with `'@nxgt/redis': minor`
- Docs, which the controller dispatches to the documentation agents:
  - **Guide** (`docs/guide/queues.md`), a "Wiring" section:
    - `defineRedis({ uri, prefix, queues })` and `import * as queues`;
    - the key layout `queue:{<prefix>:<name>}:…`, and the fact that moving a hand-bound queue under a prefix starts new keys;
    - `redis.queues.<key>` is lazy: opening costs nothing, the first `work()`/`finished()` opens the shared subscriber, and an idle worker opens its own BLPOP connection;
    - `job.key` under a prefix (`<prefix>:<queue>:<id>:<step>`), with **the cross-deployment caveat** of Decision 3 stated with its example;
    - `redis.close({ grace })`: the two phases, what `CLOSED` refuses and when, and that admin calls pass through;
    - an in-flight job past the grace is reclaimed elsewhere as one attempt;
    - a shutdown snippet (`process.on('SIGTERM', () => redis.close({ grace: '20s' }))`), noting the platform's own kill timeout.
  - **README:** the Queue section's example uses the wired form, with a row for `redis.queues` and `close({ grace })`.
  - **Troubleshooting**, one entry each:
    - `CLOSED` from add/addMany/finished, from work, and pending;
    - the queue clash messages (twice, and across kinds);
    - the prefix-with-braces refusal;
    - the new nothing-wired message.
  - **Roadmap:** the queue entry under *Now* records that wiring has landed.
- [ ] **Step 1: Export,** and add an `index.ts` type case to `test/types/queue.ts` if one is missing.
- [ ] **Step 2: Changeset.** "Queues are wired like caches and guards: `defineRedis({ queues })` gives `redis.queues.<key>` under the deployment's prefix, `redis.close({ grace })` closes their workers first, and a queue whose Redis is closed refuses `add`, `addMany`, `finished` and `work` with `QueueError` `CLOSED`."
- [ ] **Step 3: Green bar.** Run `bun run check && bun run typecheck && bun run build && bun run test && bun run verify:artifacts`. All of it must exit 0.
- [ ] **Step 4: Commit** `feat(redis): Export the wired queue types`.

## After the tasks

- [ ] Run `nxgt-review:review-before-a-pr` (code-reviewer, opus) until it reports `ready: true`, and `nxgt-docs:documentation-auditor` until it reports `ok: true`.
- [ ] Open a PR from `feat/redis-queue-wiring` into `feat/redis-queue` that names the four merge conditions, and merge it once green.
