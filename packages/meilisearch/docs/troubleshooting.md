# Troubleshooting

This package throws one error of its own, `SearchIndexError`, with a `code` of
`PRIMARY_KEY_MISMATCH`, `TASK_FAILED`, `REBUILD_FAILED` or `INVALID_EXPIRES_AT`.
Everything else comes from the
official SDK as it is: `MeilisearchApiError` (whose `cause.code` is
Meilisearch's own error code) and `MeilisearchTaskTimeOutError`. The headings
below are what each one prints; the Meilisearch messages were measured on
v1.53.2 with meilisearch-js 0.62.0.

- **Install and types**
  - [`Cannot find module 'meilisearch' or its corresponding type declarations.`](#cannot-find-module-meilisearch-or-its-corresponding-type-declarations)
  - [`Argument of type '{ sort: string[]; }' is not assignable to parameter of type 'SearchOptions<…>'`](#argument-of-type--sort-string--is-not-assignable-to-parameter-of-type-searchoptions)
  - [`Argument of type '{ readonly sortableAttributes: readonly ["year"]; … }' is not assignable to parameter of type 'Settings'.`](#argument-of-type--readonly-sortableattributes-readonly-year---is-not-assignable-to-parameter-of-type-settings)
- **Configuration and sync**
  - [`Index "movies" has the primary key "id", but its definition says "movieId".`](#index-movies-has-the-primary-key-id-but-its-definition-says-movieid)
  - [`Task 7 (settingsUpdate) on index "movies" failed:`](#task-7-settingsupdate-on-index-movies-failed)
  - [`The provided API key is invalid.`](#the-provided-api-key-is-invalid)
  - [`Rebuild of index "movies" stopped while filling "movies_next":`](#rebuild-of-index-movies-stopped-while-filling-movies_next)
  - [`Rebuild of index "movies" sent the swap with "movies_next" and could not wait for it:`](#rebuild-of-index-movies-sent-the-swap-with-movies_next-and-could-not-wait-for-it)
  - [`The Authorization header is missing. It must use the bearer authorization method.`](#the-authorization-header-is-missing-it-must-use-the-bearer-authorization-method)
- **Runtime**
  - [`timeout of 5000ms has exceeded on task 12 when waiting for it to be resolved.`](#timeout-of-5000ms-has-exceeded-on-task-12-when-waiting-for-it-to-be-resolved)
  - [``Index `movies` not found.``](#index-movies-not-found)
  - [``Index `movies`: Attribute `year` is not filterable.``](#index-movies-attribute-year-is-not-filterable)
  - [``Index `movies`: Attribute `year` is not sortable.``](#index-movies-attribute-year-is-not-sortable)
  - [``Inside `.queries[1]`: Index `nobody` not found.``](#inside-queries1-index-nobody-not-found)
  - [A search right after a write finds nothing](#a-search-right-after-a-write-finds-nothing)
- **Tenant tokens**
  - [`tenantToken for "movies": expiresAt is in the past`](#tenanttoken-for-movies-expiresat-is-in-the-past)
  - [`tenantToken for "movies": expiresAt is a number of milliseconds; it takes seconds, or a Date`](#tenanttoken-for-movies-expiresat-is-a-number-of-milliseconds-it-takes-seconds-or-a-date)
  - [`the uid of your key is not a valid UUIDv4`](#the-uid-of-your-key-is-not-a-valid-uuidv4)
  - [``Tenant token expired. Was valid up to `1790139850` and we're now `1790139910`.``](#tenant-token-expired-was-valid-up-to-1790139850-and-were-now-1790139910)
  - [``The provided tenant token cannot acces the index `people`, allowed indexes are ["movies"].``](#the-provided-tenant-token-cannot-acces-the-index-people-allowed-indexes-are-movies)
  - [``The API key used to generate this tenant token cannot acces the index `people`.``](#the-api-key-used-to-generate-this-tenant-token-cannot-acces-the-index-people)

## Install and types

### `Cannot find module 'meilisearch' or its corresponding type declarations.`

**When:** typechecking, on the first file that imports `@nxgt/meilisearch`.
**Why:** the official SDK is a required peer — you create the client, this
package never creates one — and a peer is not installed for you.
**Fix:**

```sh
bun add @nxgt/meilisearch meilisearch
```

The supported range is `>=0.62.0 <1`. A 0.x SDK can change its types in a
minor, so raise it deliberately.

### `Argument of type '{ sort: string[]; }' is not assignable to parameter of type 'SearchOptions<…>'`

**When:** typechecking a search whose options were built in a variable first.
**Why:** the searches are typed from the definition's literal types, and
`const options = { sort: ['year:desc'] }` widens to `string[]` before the
call ever sees it.
**Fix:**

```ts
import type { SearchOptions } from '@nxgt/meilisearch';

const options = { sort: ['year:desc'] } satisfies SearchOptions<typeof movies>;
await movieIndex.search('alien', options);
```

Writing the object inline in the call does the same thing.

### `Argument of type '{ readonly sortableAttributes: readonly ["year"]; … }' is not assignable to parameter of type 'Settings'.`

The line under it says which list: *The type `readonly ["year"]` is
`readonly` and cannot be assigned to the mutable type `string[]`.*

**When:** typechecking `diffSettings(movies.settings, live)` — a definition's
own settings as the first argument — **before 0.2.0**.
**Why:** `defineIndex` infers a definition's lists as `readonly`, which is
what makes `SortableOf` and the typed `sort` work, and the SDK's `Settings`
declares them mutable.
**Fix:** nothing, since 0.2.0: `diffSettings` takes them directly. Its first
parameter is `WantedSettings`, exported there — the same fields with every
list `readonly` — and a plain mutable `Settings` from anywhere still goes in,
while what comes back is a `Settings` the SDK accepts:

```ts
import { diffSettings } from '@nxgt/meilisearch';

const live = await client.index('movies').getSettings();
await client.index('movies').updateSettings(diffSettings(movies.settings, live));
```

Before 0.2.0, the cast at the call site — `movies.settings as Settings` — was
the way through.

## Configuration and sync

### `Index "movies" has the primary key "id", but its definition says "movieId".`

**When:** `sync()` or `syncIndexes()`, against an index that already exists.
**Why:** Meilisearch cannot change the primary key of an index that holds
documents, so this package refuses rather than delete anything. It is a
`SearchIndexError` with `code: 'PRIMARY_KEY_MISMATCH'`,
`expectedPrimaryKey` and `actualPrimaryKey`.
**Fix:**

```ts
// either the definition follows the index…
export const movies = defineIndex<Movie>()({ uid: 'movies', primaryKey: 'id', settings });
// …or the index is deleted and synced again, and the documents added back
await client.deleteIndex('movies');
await movieIndex.sync();
```

### `Task 7 (settingsUpdate) on index "movies" failed:`

**When:** `sync()`, or any write called with `wait`. The rest of the line is
Meilisearch's own reason.
**Why:** the SDK resolves a failed task like a succeeded one, so this package
checks every task it waited for and throws a `SearchIndexError` with
`code: 'TASK_FAILED'`; `task` is the task and `cause` its `error`. A
`canceled` task raises the same error, with `it was canceled` as the reason.
**Fix:**

```ts
import { SearchIndexError } from '@nxgt/meilisearch';

try {
	await movieIndex.sync();
} catch (error) {
	if (error instanceof SearchIndexError && error.code === 'TASK_FAILED') {
		console.error(error.task?.error); // Meilisearch's code and link
	}
	throw error;
}
```

### `The provided API key is invalid.`

**When:** `sync()` or `syncIndexes()` at start-up, with a key that can search
but not administrate. `cause.code` is `invalid_api_key` and the response is a
403.
**Why:** sync creates indexes and changes settings; a search key may do
neither.
**Fix:**

```ts
// sync with a key holding these actions, and search with the search-only one
// indexes.create, indexes.get, indexes.update, settings.get, settings.update, tasks.get
const admin = new Meilisearch({ host, apiKey: process.env.MEILI_ADMIN_KEY });
await syncIndexes(admin, [movies, books]);
```

### `Rebuild of index "movies" stopped while filling "movies_next":`

The line goes on: *"movies_next" was deleted, and "movies" is as it was.
The cause is on `cause`.* The word after *while* is `swapping` when the swap
task itself failed.

**When:** `rebuild(fill)`, when `fill` threw, or when a write it left on the
next index — waited for or only enqueued — ended `failed`.
**Why:** `rebuild` swaps nothing it has not seen succeed: a failed write
swapped in is the half-filled index it exists to prevent. It is a
`SearchIndexError` with `code: 'REBUILD_FAILED'`; searches were on the live
index throughout.
**Fix:** read `cause`, then run the rebuild again:

```ts
const error = await movieIndex.rebuild(fill).catch((e) => e);
if (error.code === 'REBUILD_FAILED') {
	console.error(error.cause);              // what fill threw, or TASK_FAILED
	console.error(error.task?.error?.code);  // e.g. 'invalid_document_id'
}
```

### `Rebuild of index "movies" sent the swap with "movies_next" and could not wait for it:`

The line goes on: *whether "movies" was swapped is unknown, and
"movies_next" was left for the next rebuild to delete.*

**When:** `rebuild(fill)` with a key restricted to named indexes —
measured with `indexes: ['movies', 'movies_next']` and with `['movies*']`,
where `cause` is the SDK's `MeilisearchApiError` ``Task `21` not found.``
(`task_not_found`) — or when the wait for the swap timed out.
**Why:** a swap task belongs to no index, and a key restricted to named
indexes cannot read it, so the wait fails at once — while the swap goes on
and, measured, succeeds. The live index is whole either way: the swap is
atomic.
**Fix:** rebuild with a key on every index, or a longer `wait`:

```ts
const key = await admin.createKey({
	actions: ['indexes.create', 'indexes.get', 'indexes.update', 'indexes.swap', 'indexes.delete',
		'settings.get', 'settings.update', 'tasks.get', 'documents.add'],
	indexes: ['*'],
	expiresAt: null,
});
await bindIndex(new Meilisearch({ host, apiKey: key.key }), movies).rebuild(fill, { wait: { timeout: 120_000 } });
```

### `The Authorization header is missing. It must use the bearer authorization method.`

**When:** the first request, on a client created with no `apiKey` against a
server started with a master key.
**Why:** the SDK sends no `Authorization` header at all, so Meilisearch
refuses before looking at anything else. An environment variable read into
the client as `undefined` looks exactly like this.
**Fix:**

```ts
const client = new Meilisearch({ host: process.env.MEILI_HOST!, apiKey: process.env.MEILI_KEY });
```

## Runtime

### `timeout of 5000ms has exceeded on task 12 when waiting for it to be resolved.`

**When:** any call with `wait` — `sync()` included — on a task that takes
longer than the SDK's default of 5 seconds. A settings change re-indexes the
documents, so a large index passes it easily.
**Why:** the wait timed out, not the task: it is a
`MeilisearchTaskTimeOutError` from the SDK, and the task carries on in
Meilisearch.
**Fix:**

```ts
await movieIndex.sync({ wait: { timeout: 120_000 } });
```

Or give the client a `defaultWaitOptions` so every wait is longer.

### ``Index `movies` not found.``

**When:** searching, reading or writing documents before the index exists.
`cause.code` is `index_not_found`.
**Why:** `defineIndex` describes the index and `bindIndex` attaches to it;
neither touches the server. Only `sync` creates it.
**Fix:**

```ts
// once, where the app starts
await syncIndexes(client, [movies, books]);
```

### ``Index `movies`: Attribute `year` is not filterable.``

**When:** a search with `filter`, `facets` or `distinct` on an attribute the
live index has not been told about. From `deleteByFilter` the same sentence
arrives inside a `SearchIndexError` with `code: 'TASK_FAILED'`, and only with
`wait`: the request is accepted and the *task* fails, so without `wait`
nothing is deleted and nothing says so.
**Why:** the types check the attribute against the **definition**, and the
server checks it against the settings it actually holds. They differ until
`sync` has run — or when `filterableAttributes` names a wildcard pattern such
as `meta.*`, which is accepted as a pattern and names no attribute.
**Fix:**

```ts
export const movies = defineIndex<Movie>()({
	uid: 'movies',
	primaryKey: 'id',
	settings: { filterableAttributes: ['genres', 'year'] },
});
await movieIndex.sync(); // applies what changed
```

### `Sending an empty filter is forbidden.`

**When:** `deleteByFilter('')`, or with blanks, `[]` or `[[]]`. The SDK's
`MeilisearchApiError` is thrown when the request is sent, with
`cause.code` `invalid_document_filter`.
**Why:** Meilisearch refuses to read an empty filter as "every document", so a
filter built from a request that turned out empty deletes nothing instead of
everything. Nothing was deleted.
**Fix:** build the filter before calling, and leave the call out when there
is nothing to filter on — `deleteAll` is the call for every document, and
`delete(ids)` the one for ids you already hold:

```ts
// genres from a request: ['horror', 'noir'], or nothing
const filter = genres.map((genre) => `genres = ${JSON.stringify(genre)}`);
if (filter.length > 0) {
	await movieIndex.deleteByFilter([filter], { wait: true }); // one OR group
}
```

### ``Index `movies`: Attribute `year` is not sortable.``

**When:** a search with `sort`.
**Why:** the same as the entry above: the definition's `sortableAttributes`
and the live index's settings differ until `sync` has run.
**Fix:**

```ts
settings: { sortableAttributes: ['year', 'rating'] }
```

Then `sync()` again: a setting the definition leaves out is never compared
nor reset, so removing it from the definition does not remove it from the
server.

### ``Inside `.queries[1]`: Index `nobody` not found.``

The same lead, ``Inside `.queries[N]`: ``, comes before any refusal of one
query in a `multiSearch` — ``Index `movies`: Attribute `name` is not
sortable.`` included.

**When:** `multiSearch(client, queries)`, when one query names an index that
does not exist, or an attribute the live index does not allow. `N` is its
position, from 0; `cause.code` is Meilisearch's own (`index_not_found`,
`invalid_search_sort`…).
**Why:** Meilisearch answers a multi-search as one request: one refused
query fails them all, and no result comes back for the others. The types
check each query against its **definition**; the server checks it against
the settings it holds, which differ until `sync` has run.
**Fix:** sync every index a multi-search reads, where the app starts:

```ts
await syncIndexes(client, [movies, people]);
const [films, persons] = await multiSearch(client, [
	{ index: movieIndex, q },
	{ index: peopleIndex, q },
]);
```

### A search right after a write finds nothing

**When:** `add`, `update` or `delete` called without `wait`, followed by a
search. There is no error.
**Why:** a write without `wait` is only **queued**: the call resolves with
the SDK's enqueued task, and Meilisearch applies it afterwards — measured at
roughly half a second per write on a small index.
**Fix:**

```ts
await movieIndex.add([alien, heat], { wait: true });
const { hits } = await movieIndex.search('alien');
```

With `wait`, a task that ends `failed` throws `SearchIndexError` instead of
resolving quietly.

## Tenant tokens

### `tenantToken for "movies": expiresAt is in the past`

Two siblings end the same line differently: `is not a whole number of
seconds`, and `is an invalid Date`.

**When:** `tenantToken({ …, expiresAt })` with a time already past, a number
of seconds with a fraction, or a `Date` built from something unparseable.
It is a `SearchIndexError` with `code: 'INVALID_EXPIRES_AT'`, thrown before
anything is signed; `indexUid` holds the token's uids joined by `,`.
**Why:** a past token would be refused by the server on its first search,
and — measured on v1.53.2 — a fractional `exp` makes every search with the
token fail: *Could not decode tenant token, JSON error: invalid type:
floating point …, expected i64*. The message never repeats the value.
**Fix:** a `Date` in the future, or whole seconds:

```ts
expiresAt: new Date(Date.now() + 60 * 60 * 1000),
// or
expiresAt: Math.floor(Date.now() / 1000) + 3600,
```

### `tenantToken for "movies": expiresAt is a number of milliseconds; it takes seconds, or a Date`

**When:** `expiresAt: Date.now() + …` — a number past 10¹¹, which as
seconds is the year 5138.
**Why:** the token's `exp` is in seconds. Measured on v1.53.2: the server
**accepts** a time in milliseconds, and the token then lasts some 56 000
years — it is refused here because nothing else would refuse it.
**Fix:** pass the `Date`, or divide:

```ts
expiresAt: new Date(Date.now() + 3_600_000),
```

### `the uid of your key is not a valid UUIDv4`

**When:** `tenantToken` with an `apiKeyUid` that is not the key's `uid` —
often the key itself, or its name. The SDK's own `Error`, thrown while
signing.
**Why:** the token names the key that signed it by its uid, a UUID v4, and
the server looks the key up by it.
**Fix:**

```ts
const searchKey = await admin.getKey(process.env.MEILI_SEARCH_KEY_UID!);
await tenantToken({ apiKey: searchKey.key, apiKeyUid: searchKey.uid, indexes: [movieIndex] });
```

### ``Tenant token expired. Was valid up to `1790139850` and we're now `1790139910`.``

**When:** a search with a client made from a token whose `exp` has passed.
A `MeilisearchApiError`, `cause.code` `invalid_api_key`, status 403.
**Why:** `tenantToken` refuses a time already past, so the token expired
between signing and searching.
**Fix:** sign a new token when the old one expires — the page asks the
server again on a 403 — and pick an `expiresAt` longer than a session's
searches.

### ``The provided tenant token cannot acces the index `people`, allowed indexes are ["movies"].``

**When:** a search, with the token, on an index that was not in its
`indexes`. `cause.code` `invalid_api_key`, status 403.
**Why:** the token may search exactly the indexes it names, and no other.
**Fix:** add the index to `indexes`, with its own rule if it needs one:

```ts
await tenantToken({ apiKey, apiKeyUid, indexes: [movieIndex, peopleIndex], searchRules: { movies: { filter } } });
```

### ``The API key used to generate this tenant token cannot acces the index `people`.``

**When:** a search, with the token, on an index the token names but the
**signing key** does not cover. `cause.code` `invalid_api_key`, status 403.
**Why:** a token can do no more than its key: its `indexes` must be among
the key's.
**Fix:** sign with a key whose `indexes` include every index the token
names, with the `search` action:

```ts
const searchKey = await admin.createKey({ actions: ['search'], indexes: ['movies', 'people'], expiresAt: null });
```
