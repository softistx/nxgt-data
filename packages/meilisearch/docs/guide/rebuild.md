# Rebuilding an index

Rebuilding an index in place — `deleteAll`, then add every document again —
leaves searches half-empty until the last batch is indexed. `rebuild` fills a
second index beside the live one and swaps it in, in one atomic task:
searches see the old documents until the swap, and the new ones after it.

```ts
import { bindIndex } from '@nxgt/meilisearch';
import { movies } from './indexes';

const movieIndex = bindIndex(client, movies);

const report = await movieIndex.rebuild(async (next) => {
	// `next` is a TypedIndex<typeof movies> bound to 'movies_next'
	for await (const page of readMoviesFromTheDatabase()) {
		await next.addInBatches(page, { batchSize: 1000 });
	}
});
// { uid: 'movies', nextUid: 'movies_next', leftoverDeleted: false, created: false,
//   sync: { … }, tasks: [indexSwap, indexDeletion] }
```

## What it does, in order

1. **Deletes a leftover.** An index under the next uid, left by a run that
   crashed before its swap, is deleted first. `leftoverDeleted: true`.
2. **Creates the next index** with the definition's primary key and
   settings, through the same [`syncIndex`](sync.md) as `sync()`. The
   report is `sync`.
3. **Hands `fill` a typed index bound to the next uid.** The same
   `TypedIndex<Def>` as the live one: its writes take the same documents,
   its searches the same sorts.
4. **Waits for every task `fill` left on the next index**, including those
   it only enqueued, without `wait`. A task among them that failed stops the
   rebuild: without this check, a write that failed would be swapped in.
5. **Swaps it in.** When the live index exists, both are swapped in one
   `indexSwap` task, which is atomic on the server; the next uid then holds
   the previous documents, and is deleted. When there is no live index yet,
   the next one is **renamed** to the live uid, and there is nothing to
   delete. `created: true`.

## When it fails

Anything that goes wrong before the swap — `fill` throws, a task it left
failed, the swap task fails — deletes the next index, leaves the live one as
it was, and throws a `SearchIndexError` with `code: 'REBUILD_FAILED'`.
`cause` is what stopped it, and `task` the failed task when there was one:

```ts
import { SearchIndexError } from '@nxgt/meilisearch';

try {
	await movieIndex.rebuild(async (next) => {
		await next.add(await loadMovies()); // enqueued: rebuild waits for it
	});
} catch (error) {
	if (error instanceof SearchIndexError && error.code === 'REBUILD_FAILED') {
		error.cause;            // what `fill` threw, or a TASK_FAILED SearchIndexError
		error.task?.error?.code; // 'invalid_document_id', when a task failed
	}
	throw error;
}
```

The searches never noticed: they were on the live index the whole time.

One failure is different. When the swap was **sent** and waiting for it
failed — a timeout, or a key that cannot read the task — the swap may have
happened, so nothing is deleted:

```
Rebuild of index "movies" sent the swap with "movies_next" and could not wait for it: whether "movies" was swapped is unknown, and "movies_next" was left for the next rebuild to delete. The cause is on `cause`.
```

Whichever it was, the live index is whole — the old documents or the new
ones — and the next rebuild deletes what is left under `movies_next`.

A failure **after** the swap — deleting the previous index — is thrown as
it comes, the SDK's `MeilisearchApiError` or a `TASK_FAILED`, not wrapped:
the swap happened, and the rebuild succeeded but for the cleanup.

## Options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `nextUid` | `string` | `'<uid>_next'` | the uid of the index filled beside the live one; the uid itself is refused |
| `wait` | `{ timeout?: number; interval?: number }` | the SDK's (5 s) | how long to wait for each task, the fill's included, and how often to ask |

```ts
await movieIndex.rebuild(fill, { nextUid: 'movies_building', wait: { timeout: 300_000 } });
```

## What was measured

On Meilisearch v1.53.2 with meilisearch-js 0.62.0. What `rebuild` does is
kept as specs in `src/sync/rebuild-index.spec.ts`; what `swapIndexes` does
on its own was measured against the same server, and is why `rebuild` is
written the way it is:

- a search on the live index **during** `fill`, before and after the next
  index is filled, returns the old documents; after `rebuild` resolves, the
  new ones;
- the swapped-in index filters, sorts and facets on the definition's
  attributes, and a `sync()` right after sends nothing;
- `swapIndexes` with a live index that does not exist fails
  `index_not_found`, whether `rename` is `false` or `true` — unless `rename`
  is `true` **and** the existing index is named first, which renames it.
  That is what the first run does;
- `rename: true` when both indexes exist fails `index_already_exists`, so a
  rename is only used when there is nothing to swap with;
- settings travel with the index in a swap: they are the next index's, set
  by the definition;
- a leftover next index with **another primary key** is deleted, not synced
  onto, so it cannot fail the rebuild with `PRIMARY_KEY_MISMATCH`.

## Changing a primary key

`sync` refuses to change the primary key of an index that exists —
[`PRIMARY_KEY_MISMATCH`](errors.md#primary_key_mismatch) — because
Meilisearch cannot change it once the index holds documents. A rebuild does
not change it either: it swaps in a new index created with the definition's
key. That makes it the way to change a primary key with no gap in the
searches:

```ts
// 'movies' exists with the primary key 'title'; the definition now says 'id'
export const movies = defineIndex<Movie>()({ uid: 'movies', primaryKey: 'id', settings });
await bindIndex(client, movies).rebuild(async (next) => {
	await next.addInBatches(await loadMovies());
});
// 'movies' now has the primary key 'id' — measured, in the spec
```

## Traps

- **Only the definition's settings are carried over.** The next index gets
  what the definition names. A setting the definition leaves out, changed on
  the live index from the dashboard, is back to its default after the swap.
- **`fill` must await its writes.** A write it only *enqueued* is waited
  for; one it started and did not await may not be enqueued yet when `fill`
  resolves, and is then swapped in unchecked — or not at all. The types
  refuse a `fill` that returns nothing, which catches the plain case.
- **Two rebuilds of one index at once collide.** The second deletes the
  first one's next index as a leftover. Run one at a time — from a job, not
  from every instance at start-up.
- **Writes to the live index during `fill` are lost at the swap.** The swap
  replaces the whole index. Send them to both, or rebuild when nothing
  writes.
- **An index with embedders embeds every document again**, which costs time
  and, with a remote embedder, requests.
- **The key needs more than `sync`'s actions, on every index.** Measured:
  `indexes.create`, `indexes.get`, `indexes.update`, `indexes.swap`,
  `indexes.delete`, `settings.get`, `settings.update`, `tasks.get` and
  `documents.add` rebuild with `indexes: ['*']`. With `indexes: ['movies',
  'movies_next']` — or `['movies*']` — the swap is sent **and happens**, but
  its task has no index, the key cannot read it, and the wait fails
  `task_not_found`: `rebuild` then throws `REBUILD_FAILED` saying the
  outcome is unknown, and deletes nothing. Without `indexes.delete` the swap
  happens and deleting the previous index throws the SDK's
  `MeilisearchApiError`.
