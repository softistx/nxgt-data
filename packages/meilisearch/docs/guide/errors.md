# Errors

Almost every failure here is the SDK's: this package adds one error,
`SearchIndexError`, for the two things it does that the SDK does not —
checking a primary key, and failing a task that failed.

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
| `TASK_FAILED` | a task this package waited for ended `failed` or `canceled` | `task`, and `cause`: the task's `error` |

```ts
class SearchIndexError extends Error {
	readonly code: SearchIndexErrorCode;      // 'PRIMARY_KEY_MISMATCH' | 'TASK_FAILED'
	readonly indexUid: string;
	readonly task: Task | undefined;
	readonly expectedPrimaryKey: string | undefined;
	readonly actualPrimaryKey: string | undefined;
	// cause: the task's error, for TASK_FAILED
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
// SearchIndexError: Task 7 (documentAdditionOrUpdate) on index "movies" failed:
// Document identifier `"not an id"` is invalid. …

const error = await movieIndex.add([bad], { wait: true }).catch((e) => e);
error.code;             // 'TASK_FAILED'
error.indexUid;         // 'movies'
error.task.status;      // 'failed'
error.task.error.code;  // 'invalid_document_id'
```

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

Two places where this package steps in front of the SDK, and only two:

- `get` turns `document_not_found` into `undefined`. A missing index is
  still thrown — an empty result and a missing index are not the same
  answer.
- `sync` treats `index_not_found` while reading as "create it", and an
  `index_already_exists` from a racing creation as "use theirs".

## One handler for the app

```ts
import { Hono } from 'hono';
import { SearchIndexError } from '@nxgt/meilisearch';
import { MeilisearchApiError, MeilisearchRequestError } from 'meilisearch';

export const app = new Hono().onError((error, c) => {
	if (error instanceof SearchIndexError) {
		console.error({ code: error.code, uid: error.indexUid, task: error.task?.uid });
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
