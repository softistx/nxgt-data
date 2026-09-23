# Errors

Almost every failure here is the SDK's: this package adds one error,
`SearchIndexError`, for the four things it does that the SDK does not —
checking a primary key, failing a task that failed, a rebuild that stopped
before its swap, and refusing a tenant token's `expiresAt`.

```ts
import { SearchIndexError } from '@nxgt/meilisearch';

try {
	await movieIndex.add(docs, { wait: true });
} catch (error) {
	if (error instanceof SearchIndexError && error.code === 'TASK_FAILED') {
		console.error(error.task?.error?.code); // 'invalid_document_id'
	}
	throw error;
}
```

## `SearchIndexError`

| `code` | Thrown when | Also carries |
| --- | --- | --- |
| `PRIMARY_KEY_MISMATCH` | [`sync`](sync.md) found the index with another primary key | `expectedPrimaryKey`, `actualPrimaryKey` |
| `TASK_FAILED` | a task this package waited for ended `failed` or `canceled` | `task`, and `cause`: the task's `error`, whose sentence the message leaves out — it can quote a filter or a document id |
| `REBUILD_FAILED` | [`rebuild`](rebuild.md) stopped before the swap, its swap task came back `failed`, or it sent the swap and could not wait for it | `cause`: what stopped it; `task` when a task failed |
| `INVALID_EXPIRES_AT` | [`tenantToken`](tenant-tokens.md) was given an `expiresAt` it will not sign | `indexUid`: the token's uids, joined by `,` |

```ts
class SearchIndexError extends Error {
	readonly code: SearchIndexErrorCode;      // 'PRIMARY_KEY_MISMATCH' | 'TASK_FAILED' | 'REBUILD_FAILED' | 'INVALID_EXPIRES_AT'
	readonly indexUid: string;
	readonly task: Task | undefined;
	readonly expectedPrimaryKey: string | undefined;
	readonly actualPrimaryKey: string | undefined;
	// cause: the task's error, for TASK_FAILED; what stopped it, for REBUILD_FAILED
}
```

### `TASK_FAILED`

Meilisearch answers a write with a task, and the SDK resolves a *failed*
task exactly like a succeeded one — `await enqueued.waitTask()` gives back a
`Task` whose `status` is `'failed'`, and nothing throws. Every call made with
`wait` checks the status for you:

```ts
const bad = { ...alien, id: 'not an id' as unknown as number };

await movieIndex.add([bad], { wait: true });
// SearchIndexError: Task 7 (add) on index "movies" failed: invalid_document_id

const error = await movieIndex.add([bad], { wait: true }).catch((e) => e);
error.code;             // 'TASK_FAILED'
error.indexUid;         // 'movies'
error.task.status;      // 'failed'
error.task.type;        // 'documentAdditionOrUpdate'
error.task.error.code;  // 'invalid_document_id'
error.cause.message;    // 'Document identifier `"not an id"` is invalid. …'
```

The message names the call you made — `add`, not the task's
`documentAdditionOrUpdate`; `deleteByFilter`, not the `documentDeletion` that
`delete` makes too; `sync` for the tasks a sync sends, and `rebuild` for every
task a rebuild waits for, the next index's creation and settings included —
and
Meilisearch's error code, and nothing else. Meilisearch's own sentence quotes
the id it refused or the filter it could not apply, which came from your
documents or a request, so it stays on `cause` and `task.error`: log the
message freely, and read the cause where you choose to. A `canceled` task has
no error, and its message ends at `canceled`.

Without `wait`, nothing is checked, because nothing is awaited: the task is
queued and the promise resolves. `deleteByFilter` on an attribute that is not
filterable is the sharpest case: the request is accepted, the task fails, and
without `wait` nothing is deleted and nothing says so — see
[Deleting by filter](documents.md#deleting-by-filter). Waiting on the SDK's side means reading the
status yourself.

```ts
const task = await movieIndex.add(docs).waitTask(); // no `wait`: the SDK's own
if (task.status !== 'succeeded') report(task.error);
```

### `PRIMARY_KEY_MISMATCH`

Meilisearch cannot change the primary key of an index that holds documents,
so `sync` refuses rather than delete anything:

```ts
const error = await movieIndex.sync().catch((e) => e);
error.code;              // 'PRIMARY_KEY_MISMATCH'
error.expectedPrimaryKey; // 'id', from the definition
error.actualPrimaryKey;   // 'movieId', on the server
```

The fix is a decision, not a retry: either the definition takes the server's
key, or the index is deleted and re-synced and the documents are written
again.

### `REBUILD_FAILED`

[`rebuild`](rebuild.md) fills `<uid>_next` and swaps it in. Anything that
stops it before the swap deletes `<uid>_next` and leaves the live index as
it was; `cause` is the reason — what `fill` threw, or a `TASK_FAILED`
`SearchIndexError` for a task `fill` left that failed, whose `task` is also
copied onto this error:

```ts
const error = await movieIndex.rebuild(fill).catch((e) => e);
error.code;              // 'REBUILD_FAILED'
error.cause;             // what fill threw, or a TASK_FAILED SearchIndexError
error.task?.error?.code; // 'invalid_document_id', when a task failed
```

When the swap was sent and could not be waited for, the message says the
outcome is unknown, and nothing is deleted. The swap is atomic, so the live
index is whole either way.

### `INVALID_EXPIRES_AT`

[`tenantToken`](tenant-tokens.md) refuses, before signing, an `expiresAt`
already past, a number of milliseconds, a fraction of a second, or an
invalid `Date` — the last three measured to be accepted wrongly, or not
decoded, by the server. An `expiresAt` can come from a request, so it has a
code a handler can answer 400 to:

```ts
const error = await tenantToken({ apiKey, apiKeyUid, indexes: [movieIndex], expiresAt: Date.now() }).catch((e) => e);
error.code;     // 'INVALID_EXPIRES_AT'
error.message;  // 'tenantToken for "movies": expiresAt is a number of milliseconds; it takes seconds, or a Date'
error.indexUid; // 'movies'
```

The message never holds the key, nor the time it was given.

## The SDK's errors, unchanged

| Error | When |
| --- | --- |
| `MeilisearchApiError` | Meilisearch refused the request; `cause.code` is its own code — `index_not_found`, `invalid_search_sort`, `invalid_api_key` |
| `MeilisearchRequestError` | the request never reached a server: wrong host, DNS, connection refused |
| `MeilisearchTaskTimeOutError` | a wait ran out; **the task is still running in Meilisearch** |

```ts
import { MeilisearchApiError } from 'meilisearch';

try {
	await movieIndex.get(1);
} catch (error) {
	if (error instanceof MeilisearchApiError && error.cause?.code === 'index_not_found') {
		// Nobody has synced this index yet.
	}
	throw error;
}
```

Three places where this package steps in front of the SDK, and only three:

- `get` turns `document_not_found` into `undefined`. A missing index is
  still thrown — an empty result and a missing index are not the same
  answer.
- `sync` treats `index_not_found` while reading as "create it", and an
  `index_already_exists` from a racing creation as "use theirs".
- `rebuild` wraps whatever stops it between creating the next index and
  reading back its swap task — the SDK's error included — in a
  `REBUILD_FAILED`, as `cause`, because it cleaned up after it. Not
  wrapped: the `nextUid` refusal (a bare `TypeError`) and a failure to
  delete a leftover `_next`, both before; a failure to delete the previous
  index, after the swap.

## One handler for the app

```ts
import { Hono } from 'hono';
import { SearchIndexError } from '@nxgt/meilisearch';
import { MeilisearchApiError, MeilisearchRequestError } from 'meilisearch';

export const app = new Hono().onError((error, c) => {
	if (error instanceof SearchIndexError) {
		// An expiresAt from the request: the caller's input.
		if (error.code === 'INVALID_EXPIRES_AT') return c.json({ error: 'expiresAt' }, 400);
		// A rebuild carries what stopped it — often the SDK's error — as cause.
		const cause = error.code === 'REBUILD_FAILED' ? error.cause : undefined;
		console.error({
			code: error.code,
			uid: error.indexUid,
			task: error.task?.uid,
			cause: cause instanceof MeilisearchApiError ? cause.cause?.code : cause,
		});
		return c.json({ error: 'Search is not available' }, 503);
	}
	if (error instanceof MeilisearchRequestError) {
		return c.json({ error: 'Search is not available' }, 503);
	}
	if (error instanceof MeilisearchApiError) {
		// A bad filter or sort is the caller's input; anything else is ours.
		const code = error.cause?.code ?? '';
		return code.startsWith('invalid_search')
			? c.json({ error: code }, 400)
			: c.json({ error: 'Search failed' }, 500);
	}
	return c.json({ error: 'Internal error' }, 500);
});
```

Error messages, symptom by symptom, are in
[troubleshooting.md](../troubleshooting.md).
