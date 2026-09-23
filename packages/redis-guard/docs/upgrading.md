# Upgrading

What to change in your code when you move `@nxgt/redis-guard` from one minor
to the next. Each minor is a `0.x` release, so each can ask for something;
the [changelog](https://github.com/softistx/nxgt-data/blob/develop/packages/redis-guard/CHANGELOG.md) has every change, and this page has only
what you have to do.

## 0.2.0 → 0.3.0

Nothing has to change for the code to compile: 0.3.0 adds the `wait` option,
and renames nothing. Three things are worth doing.

### `lease` can be shortened

In 0.2.0 the lease was never renewed, so it had to cover the whole of `work`,
and work that outlasted it could run twice. In 0.3.0 `run` renews it every
third of `lease` while `work` runs, so `lease` now bounds only how long a
**crashed** run holds the key, and how long the event loop may be blocked or
Redis unreachable before a live run loses it.

```ts
import { z } from 'zod';
import { defineIdempotency } from '@nxgt/redis-guard';

export const createReport = defineIdempotency({
	name: 'reports.create',
	key: (key: string) => key,
	ttl: 86_400,
	// 0.2.0: lease: 600_000, because a report could take ten minutes.
	lease: 15_000, // 0.3.0: a crash frees the key within 15 s; renewed while work runs
	schema: z.object({ reportId: z.string() }),
});
```

The [lease](guide/idempotency.md#the-lease) has what it bounds in full.

### Match on `code`, not on the message

Two messages changed. Code that tested their text stops matching:

| Code | 0.2.0 message | 0.3.0 message |
| --- | --- | --- |
| `IN_PROGRESS` | `run on "<name>": the same key is still running; retryAfter says when its lease ends` | `run on "<name>": the same key is still running; retryAfter is when its lease lapses unless renewed` |
| `LEASE_LOST` | `run on "<name>": the work outlasted its lease of <lease>ms, so a repeat may have run it too; its result was not stored` | `run on "<name>": the key was taken from this run before it finished (forgotten, or its lease of <lease>ms went unrenewed), so a repeat may have run it too; its result was not stored` |

The `code` is the contract, and did not change:

```ts
import { GuardError } from '@nxgt/redis-guard';

function isStillRunning(error: unknown): boolean {
	// Not: error.message.includes('its lease ends')
	return error instanceof GuardError && error.code === 'IN_PROGRESS';
}
```

`IN_PROGRESS`'s `retryAfter` also means something else now: when the running
call's lease lapses **unless renewed**. A live run renews it, so a retry after
`retryAfter` can still find the key running. Give `run` a `wait` to get the
replay instead — see [Waiting for a running key](guide/idempotency.md#waiting-for-a-running-key).

### A rolling deploy can mix the two versions

0.3.0 stores the same record as 0.2.0 — one hash, the same three fields in
each state — and takes, stores and gives back a key with the same scripts; it
only adds one that renews a running key. So 0.2.0 and 0.3.0 processes can
share the same keys during a rollout: each replays what the other stored, and
each refuses a key the other is running.

What differs is that **a 0.2.0 process does not renew**: work it runs is
still covered only by its own `lease`, as before. The `lease` is part of the
definition, which ships with the code, so a 0.2.0 process keeps the long
lease it was deployed with — shortening it in the same deploy is safe. If
the value comes from configuration both versions read, shorten it only once
no 0.2.0 process is left.

During the rollout a caller may get either version's message for the same
`code`, which is one more reason to match on `code`.

## 0.1.0 → 0.2.0

**`zod` became a required peer**, `>=4.6.5 <5`, for idempotency's schemas.
Install it, even if you only use rate limits:

```sh
bun add zod
```

Bun installs a missing peer by itself unless told not to, so this usually
goes unnoticed; where peers are not installed, `tsc` fails on the shipped
declarations — see [troubleshooting](troubleshooting.md#cannot-find-module-zod-or-its-corresponding-type-declarations).
Nothing about rate limits changed.
