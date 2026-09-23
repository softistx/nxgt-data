# Troubleshooting

This package throws one error class of its own, `SearchIndexError`, with a
`code` of `PRIMARY_KEY_MISMATCH`, `TASK_FAILED`, `REBUILD_FAILED` or
`INVALID_EXPIRES_AT`, and bare `TypeError`s for a call it refuses before
sending or signing anything: a uid that is not a Meilisearch uid, from
`defineIndex`, `bindIndex` or `rebuild`, `rebuild`'s `nextUid`, and `tenantToken`'s
index uid that is not a Meilisearch uid, missing rule, empty rule, unmatched rule, `searchRules` that is not a plain
object, and rule that is not `null` or a plain `{ filter }`. Everything else comes from the
official SDK as it is: `MeilisearchApiError` (whose `cause.code` is
Meilisearch's own error code) and `MeilisearchTaskTimeOutError`. The headings
below are what each one prints; the Meilisearch messages were measured on
v1.53.2 with meilisearch-js 0.62.0.

- **Install and types**
  - [`Cannot find module 'meilisearch' or its corresponding type declarations.`](#cannot-find-module-meilisearch-or-its-corresponding-type-declarations)
  - [`Type 'string' is not assignable to type 'never'.`](#type-string-is-not-assignable-to-type-never), on a literal `uid`
  - [`Argument of type '{ sort: string[]; }' is not assignable to parameter of type 'SearchOptions<…>'`](#argument-of-type--sort-string--is-not-assignable-to-parameter-of-type-searchoptions)
  - [`Argument of type '{ readonly sortableAttributes: readonly ["year"]; … }' is not assignable to parameter of type 'Settings'.`](#argument-of-type--readonly-sortableattributes-readonly-year---is-not-assignable-to-parameter-of-type-settings)
- **Configuration and sync**
  - [`defineIndex: the uid must be 1 to 400 characters, each an ASCII letter, a digit, - or _`](#defineindex-the-uid-must-be-1-to-400-characters-each-an-ascii-letter-a-digit---or-_)
  - [`bindIndex: the definition's uid must be 1 to 400 characters, each an ASCII letter, a digit, - or _`](#bindindex-the-definitions-uid-must-be-1-to-400-characters-each-an-ascii-letter-a-digit---or-_)
  - [`Index "movies" has the primary key "id", but its definition says "movieId".`](#index-movies-has-the-primary-key-id-but-its-definition-says-movieid)
  - [`Task 7 (add) on index "movies" failed: invalid_document_id`](#task-7-add-on-index-movies-failed-invalid_document_id)
  - [`The provided API key is invalid.`](#the-provided-api-key-is-invalid)
  - [`Rebuild of index "movies" stopped while filling "movies_next":`](#rebuild-of-index-movies-stopped-while-filling-movies_next)
  - [`Rebuild of index "movies" stopped while creating "movies_next":`](#rebuild-of-index-movies-stopped-while-creating-movies_next)
  - [`Rebuild of index "movies" stopped while swapping "movies_next":`](#rebuild-of-index-movies-stopped-while-swapping-movies_next)
  - [`Rebuild of index "movies" sent the swap with "movies_next" and could not wait for it:`](#rebuild-of-index-movies-sent-the-swap-with-movies_next-and-could-not-wait-for-it)
  - [`rebuild on "movies": nextUid must differ from the index's own uid`](#rebuild-on-movies-nextuid-must-differ-from-the-indexs-own-uid)
  - [`rebuild on "movies": the next index's uid must be 1 to 400 characters, each an ASCII letter, a digit, - or _; a uid over 395 characters needs a shorter nextUid`](#rebuild-on-movies-the-next-indexs-uid-must-be-1-to-400-characters-each-an-ascii-letter-a-digit---or-_-a-uid-over-395-characters-needs-a-shorter-nextuid)
  - [`rebuild on "movies": nextUid must be 1 to 400 characters, each an ASCII letter, a digit, - or _`](#rebuild-on-movies-nextuid-must-be-1-to-400-characters-each-an-ascii-letter-a-digit---or-_)
  - [`The Authorization header is missing. It must use the bearer authorization method.`](#the-authorization-header-is-missing-it-must-use-the-bearer-authorization-method)
- **Runtime**
  - [`timeout of 5000ms has exceeded on task 12 when waiting for it to be resolved.`](#timeout-of-5000ms-has-exceeded-on-task-12-when-waiting-for-it-to-be-resolved)
  - [``Index `movies` not found.``](#index-movies-not-found)
  - [``Index `movies`: Attribute `year` is not filterable.``](#index-movies-attribute-year-is-not-filterable)
  - [`Task 7 (deleteByFilter) on index "movies" failed: invalid_document_filter`](#task-7-deletebyfilter-on-index-movies-failed-invalid_document_filter)
  - [`Sending an empty filter is forbidden.`](#sending-an-empty-filter-is-forbidden)
  - [``Index `movies`: Attribute `year` is not sortable.``](#index-movies-attribute-year-is-not-sortable)
  - [``Inside `.queries[1]`: Index `nobody` not found.``](#inside-queries1-index-nobody-not-found)
  - [A search right after a write finds nothing](#a-search-right-after-a-write-finds-nothing)
- **Tenant tokens**
  - [`tenantToken for "movies": expiresAt is missing; it takes a Date, or whole seconds since the epoch`](#tenanttoken-for-movies-expiresat-is-missing-it-takes-a-date-or-whole-seconds-since-the-epoch)
  - [`tenantToken for "movies", "people": searchRules has no rule for "people"; give each index { filter: … }, or null to search it with no filter`](#tenanttoken-for-movies-people-searchrules-has-no-rule-for-people-give-each-index--filter---or-null-to-search-it-with-no-filter)
  - [`tenantToken for "movies", "people": searchRules has an empty rule for "people"; give it { filter: … }, or null to search it with no filter`](#tenanttoken-for-movies-people-searchrules-has-an-empty-rule-for-people-give-it--filter---or-null-to-search-it-with-no-filter)
  - [`tenantToken for "movies": searchRules has a rule for "movies" that is not a plain object; give it { filter: … }, or null to search it with no filter`](#tenanttoken-for-movies-searchrules-has-a-rule-for-movies-that-is-not-a-plain-object-give-it--filter---or-null-to-search-it-with-no-filter)
  - [`tenantToken for "movies": searchRules has a rule for "movies" whose filter is a getter; give it { filter: … }, or null to search it with no filter`](#tenanttoken-for-movies-searchrules-has-a-rule-for-movies-whose-filter-is-a-getter-give-it--filter---or-null-to-search-it-with-no-filter)
  - [`tenantToken for "movies": searchRules has a rule for "movies" that has a toJSON; give it { filter: … }, or null to search it with no filter`](#tenanttoken-for-movies-searchrules-has-a-rule-for-movies-that-has-a-tojson-give-it--filter---or-null-to-search-it-with-no-filter)
  - [`tenantToken for "movies": searchRules has a rule for "movies" whose filter is a number; give it { filter: … }, or null to search it with no filter`](#tenanttoken-for-movies-searchrules-has-a-rule-for-movies-whose-filter-is-a-number-give-it--filter---or-null-to-search-it-with-no-filter)
  - [`tenantToken for "movies": expiresAt is in the past`](#tenanttoken-for-movies-expiresat-is-in-the-past)
  - [`tenantToken for "movies": expiresAt is not a whole number of seconds`](#tenanttoken-for-movies-expiresat-is-not-a-whole-number-of-seconds)
  - [`tenantToken for "movies": expiresAt is an invalid Date`](#tenanttoken-for-movies-expiresat-is-an-invalid-date)
  - [`tenantToken for "movies": expiresAt is neither a Date nor a finite number`](#tenanttoken-for-movies-expiresat-is-neither-a-date-nor-a-finite-number)
  - [`tenantToken for "movies": expiresAt is a Date past the year 5138; was it built from milliseconds times 1000?`](#tenanttoken-for-movies-expiresat-is-a-date-past-the-year-5138-was-it-built-from-milliseconds-times-1000)
  - [`tenantToken for "movies": expiresAt is a number of milliseconds; it takes seconds, or a Date`](#tenanttoken-for-movies-expiresat-is-a-number-of-milliseconds-it-takes-seconds-or-a-date)
  - [`tenantToken for "movies_next": searchRules names "movies", which is not the uid of any of its indexes`](#tenanttoken-for-movies_next-searchrules-names-movies-which-is-not-the-uid-of-any-of-its-indexes)
  - [`tenantToken: an index uid is not a valid Meilisearch uid (letters, digits, - and _ only), and a * in it would widen the token to other indexes`](#tenanttoken-an-index-uid-is-not-a-valid-meilisearch-uid-letters-digits---and-_-only-and-a--in-it-would-widen-the-token-to-other-indexes)
  - [`tenantToken for "movies": searchRules must be a plain object`](#tenanttoken-for-movies-searchrules-must-be-a-plain-object)
  - [`the uid of your key is not a valid UUIDv4`](#the-uid-of-your-key-is-not-a-valid-uuidv4)
  - [`failed to detect a server-side environment; do not generate tokens on the frontend in production!`](#failed-to-detect-a-server-side-environment-do-not-generate-tokens-on-the-frontend-in-production)
  - [``Tenant token expired. Was valid up to `1790139850` and we're now `1790139910`.``](#tenant-token-expired-was-valid-up-to-1790139850-and-were-now-1790139910)
  - [``The provided tenant token cannot acces the index `people`, allowed indexes are ["movies"].``](#the-provided-tenant-token-cannot-acces-the-index-people-allowed-indexes-are-movies)
  - [``The API key used to generate this tenant token cannot acces the index `people`.``](#the-api-key-used-to-generate-this-tenant-token-cannot-acces-the-index-people)

## Install and types

### `Type 'string' is not assignable to type 'never'.`

**When:** typechecking a `defineIndex` call whose `uid` is a literal that is
empty or holds a space, a `*`, a dot or a slash. Captured with tsc on
`{ uid: '*' }` and `{ uid: 'movies.v2' }`; the error points at `uid`, and
its detail says where `never` came from:

```text
error TS2322: Type 'string' is not assignable to type 'never'.
  The expected type comes from property 'uid' which is declared here on type
  '{ readonly uid: "*"; readonly primaryKey: "id"; } & NoExtraKeys<…> & { uid: never; } & { ...; }'
```

**Why:** Meilisearch refuses such a uid (`invalid_index_uid`), and a `*` in
one would widen a tenant token to other indexes, so the types turn `uid`
into `never` for the common mistakes. Only those: a unicode lookalike, 401
characters, or a uid typed `string` compiles, and
[`defineIndex` throws](#defineindex-the-uid-must-be-1-to-400-characters-each-an-ascii-letter-a-digit---or-_) at run time.
**Fix:** a uid of ASCII letters, digits, `-` and `_`:

```ts
defineIndex<Movie>()({ uid: 'movies_v2', primaryKey: 'id' });
```

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

### `defineIndex: the uid must be 1 to 400 characters, each an ASCII letter, a digit, - or _`

**When:** `defineIndex<Doc>()({ uid, … })` with a uid Meilisearch would
refuse: empty, over 400 characters, or holding anything but ASCII letters,
digits, `-` and `_` — a `*`, a space, a dot, a slash, a unicode lookalike
(`＊`, a Cyrillic `о`), a trailing newline. Typically a uid built from a
request, `docs_${tenant}`. A bare `TypeError`, thrown at definition, before
any request; it names no uid, since one built from a request should stay out
of logs. Since 0.6.0: before, the server refused it on the first request
(`invalid_index_uid`), and `tenantToken` on signing.
**Why:** the rule is the server's, measured on v1.53.2. A `*` matters beyond
that refusal: a tenant token reads its rule keys as index **patterns**, so a
uid holding one would widen a token to other indexes. A literal `'*'`, `''`,
or one with a space, a dot or a slash does not compile; everything else,
and every uid typed `string`, is caught here at run time.
**Fix:** use `_` or `-` where the uid had a dot or a space, and check a
uid built from a request before defining it — the whole uid, since the
prefix counts toward the 400, and 395 if the index is to be rebuilt under
`<uid>_next`:

```ts
const uid = `docs_${tenant}`;
if (!/^[A-Za-z0-9_-]{1,395}$/.test(uid)) throw new Error('bad tenant');
const docs = bindIndex(client, defineIndex<Doc>()({ uid, primaryKey: 'id' }));
```

An existing index whose uid held a dot cannot be on the server: Meilisearch
v1.53.2 refuses to create one.

### `bindIndex: the definition's uid must be 1 to 400 characters, each an ASCII letter, a digit, - or _`

**When:** `bindIndex(client, definition)` with a definition that did not come
from `defineIndex` — an object written by hand, or cast — whose uid
Meilisearch would refuse. A bare `TypeError`, before any request; it names
no uid.
**Why:** `defineIndex` is where a uid is checked, but `bindIndex` takes any
object shaped like a definition, and the typed index it returns is what
`tenantToken` signs for. It checks with the same rule.
**Fix:** define the index with `defineIndex`, which refuses the same uid
earlier, and check a uid built from a request as above.

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

### `Task 7 (add) on index "movies" failed: invalid_document_id`

**When:** `sync()`, `rebuild()`, or any write called with `wait`. In the
parentheses is the call you made — `add`, `addInBatches`, `update`,
`updateInBatches`, `delete`, `deleteByFilter`, `deleteAll`, `sync` or
`rebuild` — and after the colon is Meilisearch's error code. A `canceled`
task ends the line at `canceled`: it has no error, so no code.
**Why:** the SDK resolves a failed task like a succeeded one, so this package
checks every task it waited for and throws a `SearchIndexError` with
`code: 'TASK_FAILED'`; `task` is the task and `cause` its `error`.
Meilisearch's own sentence is on `cause.message`, not in the message: it
quotes the document id it refused, or the filter it could not apply, and a
log line should not carry what your documents held. Before 0.4.1 the message
was `Task 7 (documentAdditionOrUpdate) on index "movies" failed: ` followed
by that sentence; match on `code` and `task.error.code`, never on the text.
**Fix:** read the sentence where it is kept, and fix what it names — here, an
id Meilisearch refuses: only `a-z A-Z 0-9`, `-` and `_`, at most 511 bytes.

```ts
import { SearchIndexError } from '@nxgt/meilisearch';

try {
	await movieIndex.add(docs, { wait: true });
} catch (error) {
	if (error instanceof SearchIndexError && error.code === 'TASK_FAILED') {
		error.task?.error?.code;        // 'invalid_document_id'
		error.task?.type;               // 'documentAdditionOrUpdate'
		(error.cause as Error).message; // Meilisearch's sentence, with the id
	}
	throw error;
}
```

### `The provided API key is invalid.`

**When:** `sync()` or `syncIndexes()` at start-up, with a key that can search
but not administrate. `cause.code` is `invalid_api_key` and the response is a
403. Also a search with a **tenant token** whose signing key has since been
deleted — in the specs — or has expired — measured by hand — on v1.53.2,
whatever the token's own `expiresAt`.
**Why:** sync creates indexes and changes settings; a search key may do
neither. A tenant token is checked against the key that signed it, on every
search: no key, no token.
**Fix:**

```ts
// sync with a key holding these actions, and search with the search-only one
// indexes.create, indexes.get, indexes.update, settings.get, settings.update, tasks.get
const admin = new Meilisearch({ host, apiKey: process.env.MEILI_ADMIN_KEY });
await syncIndexes(admin, [movies, books]);
```

For a tenant token, sign a new one with a live key; rotating a key revokes
every token it signed.

### `Rebuild of index "movies" stopped while filling "movies_next":`

The line goes on: *"movies_next" was deleted, and "movies" is as it was.
The cause is on `cause`.* For `creating` and `swapping`, see the next two
entries. When the next index could not be deleted — a key without
`indexes.delete`, measured — *was deleted* reads *could not be deleted; the
next rebuild deletes it first*.

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

### `Rebuild of index "movies" stopped while creating "movies_next":`

The line goes on: *"movies_next" was deleted, and "movies" is as it was.
The cause is on `cause`.*

**When:** `rebuild(fill)`, before `fill` runs: creating `movies_next` or
applying the definition's settings to it failed. Measured with a key
lacking `settings.update`, and with one lacking `indexes.create`: `cause` is
the SDK's `MeilisearchApiError` `The provided API key is invalid.`
(`invalid_api_key`). When the creation itself was refused there is nothing
to delete — the deletion fails `index_not_found`, which counts as gone —
and the line still says *was deleted*.
**Why:** the next index is created by the same `syncIndex` as `sync()`, so
it needs the same actions; the half-made index is deleted so that nothing
of it is swapped in later.
**Fix:** give the rebuilding key what `sync` needs, plus `indexes.swap`,
`indexes.delete` and `documents.add`, on every index:

```ts
const key = await admin.createKey({
	actions: ['indexes.create', 'indexes.get', 'indexes.update', 'indexes.swap', 'indexes.delete',
		'settings.get', 'settings.update', 'tasks.get', 'documents.add'],
	indexes: ['*'],
	expiresAt: null,
});
```

### `Rebuild of index "movies" stopped while swapping "movies_next":`

The line goes on: *"movies_next" was deleted, and "movies" is as it was.
The cause is on `cause`.* — or *could not be deleted; the next rebuild
deletes it first*, as for `filling`.

**When:** `rebuild(fill)`, after `fill` and its tasks succeeded: looking up
the live index before the swap failed, or the swap task was read back and
had ended `failed` or `canceled`. `cause` is the SDK's error, or a
`TASK_FAILED` `SearchIndexError` whose `task` — the swap — is copied onto
this error. Not measured against a server: v1.53.2 fails no swap of two
indexes that exist, and this package sends no other.
**Why:** a swap that failed changed nothing — it is one atomic task — so
the live index is as it was, and the next one is deleted like any other
stop before the swap. It is not the *unknown* case below: here the task was
read back.
**Fix:** read `task.error.code` and `cause`, then rebuild again:

```ts
const error = await movieIndex.rebuild(fill).catch((e) => e);
if (error.code === 'REBUILD_FAILED') console.error(error.task?.error?.code, error.cause);
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

### `rebuild on "movies": nextUid must differ from the index's own uid`

**When:** `rebuild(fill, { nextUid: 'movies' })` — the live uid given as the
next one. A bare `TypeError`, thrown before anything is sent.
**Why:** the next index is filled beside the live one and swapped with it;
under the same uid, the rebuild would fill the live index in place, which
is the half-empty search it exists to avoid.
**Fix:** leave `nextUid` out (`movies_next`), or name another uid:

```ts
await movieIndex.rebuild(fill, { nextUid: 'movies_building' });
```

### `rebuild on "movies": the next index's uid must be 1 to 400 characters, each an ASCII letter, a digit, - or _; a uid over 395 characters needs a shorter nextUid`

**When:** `rebuild(fill)` with no `nextUid`, on an index whose uid is 396 to
400 characters: valid, but its default `<uid>_next` is 401 to 405, past the
server's 400. A bare `TypeError`, thrown before anything is sent: no index
is created or deleted.
**Why:** measured on v1.53.2, a 400-character uid is created and a
401-character one is refused with `invalid_index_uid`; without this check the
rebuild failed on its first request with the SDK's error.
**Fix:** pass a shorter `nextUid`, or keep uids to 395 characters:

```ts
await longIndex.rebuild(fill, { nextUid: 'reports_next' });
```

### `rebuild on "movies": nextUid must be 1 to 400 characters, each an ASCII letter, a digit, - or _`

**When:** `rebuild(fill, { nextUid })` with a `nextUid` Meilisearch would
refuse: empty, over 400 characters, or holding a `*`, a dot, a space, a
slash, a unicode lookalike — anything but ASCII letters, digits, `-` and
`_`. A bare `TypeError`, thrown before anything is sent: no index is created
or deleted. It names the live uid, never the `nextUid`, which may have been
built from something a log should not hold.
**Why:** the server refuses such a uid with `invalid_index_uid`, and a `*`
in a uid is a pattern to a tenant token. The rule is `defineIndex`'s.
**Fix:** give a `nextUid` of letters, digits, `-` and `_`, or leave it out
for `<uid>_next`:

```ts
await movieIndex.rebuild(fill, { nextUid: 'movies_building' });
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
`cause.code` is `index_not_found`. A delete waited for on an index nothing
created fails as a *task* instead: `Task 7 (delete) on index "movies" failed:
index_not_found`, with this sentence on its `cause`.
**Why:** `defineIndex` describes the index and `bindIndex` attaches to it;
neither touches the server. Only `sync` creates it.
**Fix:**

```ts
// once, where the app starts
await syncIndexes(client, [movies, books]);
```

### ``Index `movies`: Attribute `year` is not filterable.``

**When:** a search with `filter`, `facets` or `distinct` on an attribute the
live index has not been told about. From `deleteByFilter` it is the
[next entry](#task-7-deletebyfilter-on-index-movies-failed-invalid_document_filter).
From a **tenant token** whose rule
filters on an attribute the index does not make filterable, every search
made with the token fails with it — measured in the specs, `cause.code`
`invalid_search_filter`, status 400 — whatever the search itself asks.
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

### `Task 7 (deleteByFilter) on index "movies" failed: invalid_document_filter`

**When:** `deleteByFilter` with `wait`, on an attribute the live index does
not make filterable. The request is accepted and the *task* fails, so
without `wait` nothing is deleted and nothing says so.
**Why:** the same as the entry above. The sentence — ``Index `movies`:
Attribute `rating` is not filterable. …``, followed by the filter you sent —
is on `cause.message` and `task.error.message`, never in the message: a
filter is built from a request, and it can hold anything the request held.
**Fix:** make the attribute filterable, as above, and `sync`.

```ts
const error = await movieIndex
	.deleteByFilter('rating > 8', { wait: true })
	.catch((e) => e);
error.code;          // 'TASK_FAILED'
error.task.type;     // 'documentDeletion', which `delete` makes too
error.cause.message; // 'Index `movies`: Attribute `rating` is not filterable. …'
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

### `tenantToken for "movies": expiresAt is missing; it takes a Date, or whole seconds since the epoch`

**When:** `tenantToken` with no `expiresAt`, or with `undefined` or `null` —
a field a request body left out. A `SearchIndexError` with
`code: 'INVALID_EXPIRES_AT'`, like the other refused times, thrown before
anything is signed. Since 0.5.0; before, the token was signed.
**Why:** a token without `exp` lasts as long as its key — for a browser
token, that is a credential nobody meant to be permanent.
**Fix:** give every token an end:

```ts
await tenantToken({ apiKey, apiKeyUid, indexes: [movieIndex], searchRules: { movies: { filter } }, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
```

### `tenantToken for "movies", "people": searchRules has no rule for "people"; give each index { filter: … }, or null to search it with no filter`

**When:** `tenantToken` whose `searchRules` has no rule for one of its
`indexes` — the key left out, set to `undefined`, or `searchRules` left out
altogether. A bare `TypeError`, thrown before anything is signed. The types
refuse it too for an index whose uid is a literal; for a rebuild's next
index, typed `string`, or an index typed as a union of uids —
`cond ? movieIndex : peopleIndex` — only this check sees it. Since 0.5.0.
**Why:** an index with no rule would be searched with **no filter** by
anyone holding the token. That has to be asked for, with `null`, never
reached by leaving a line out. The message names the uids, never a rule.
**Fix:** a rule per index, `null` for one that may be read in full:

```ts
await tenantToken({ apiKey, apiKeyUid, indexes: [movieIndex, peopleIndex], searchRules: { movies: { filter }, people: null }, expiresAt });
```

### `tenantToken for "movies", "people": searchRules has an empty rule for "people"; give it { filter: … }, or null to search it with no filter`

**When:** `tenantToken` with a rule object that filters nothing: no
`filter`, `filter: undefined` or `null`, a blank string (blank as the server reads it: Rust's `White_Space`, which is JavaScript's `\s` plus U+0085 (NEL), measured on v1.53.2; U+FEFF, which `\s` holds, is refused too), an empty array, or an array of those (`['', []]`,
`['\u0085']`) — typically a filter built from a value that
came back empty. A bare `TypeError`, thrown before anything is signed; every
empty rule is named. The types refuse a rule with no `filter`, an
`undefined` or a `null` one; an empty string or array compiles, since the
SDK's `Filter` is any string or array, and only this check sees it. Since
0.5.0.
**Why:** a rule that filters nothing signs the same unfiltered token as a
missing one. "No filter" is spelled only `null`, where a reviewer sees it.
The message names the uids, never the rule.
**Fix:** a filter that filters, or `null` if the index may be read in full:

```ts
const filter = user.tenant ? `tenant = ${JSON.stringify(user.tenant)}` : undefined;
if (!filter) throw new Error('no tenant'); // do not sign a token that reads everything
await tenantToken({ apiKey, apiKeyUid, indexes: [movieIndex, peopleIndex], searchRules: { movies: { filter }, people: null }, expiresAt });
```

### `tenantToken for "movies": searchRules has a rule for "movies" that is not a plain object; give it { filter: … }, or null to search it with no filter`

**When:** `tenantToken` with a rule that is not `null` or a plain object: a
class instance, or `Object.create({ filter })`, whose `filter` is inherited.
Siblings end the same line differently: `that is an array` (`['']`, whose
`filter` would have been `Array.prototype.filter`), `that is a string`,
`that is a number`. A bare `TypeError`, before anything is signed. A class
whose `filter` is a getter compiles — TypeScript cannot tell a getter from
a property — and only this check sees it.
**Why:** each rule is read once into a plain copy, and that copy is signed.
The SDK signs `JSON.stringify` of its rules, which leaves out an inherited
`filter`: measured on v1.53.2, that signed an unfiltered token.
**Fix:** a plain object literal, or `null`:

```ts
await tenantToken({ apiKey, apiKeyUid, indexes: [movieIndex], searchRules: { movies: { filter: rule.filter } }, expiresAt });
```

### `tenantToken for "movies": searchRules has a rule for "movies" whose filter is a getter; give it { filter: … }, or null to search it with no filter`

**When:** a rule whose `filter` is a getter. Siblings: `whose filter is not
enumerable` (`Object.defineProperty` without `enumerable: true`),
`that is a getter` (a getter on `searchRules` itself), and `that is not
enumerable`. A bare `TypeError`, before anything is signed; the getter is
never called.
**Why:** a getter can answer one value to the check and another when the
SDK serialises the rule — measured on v1.53.2, one that changed between
reads signed an unfiltered token — and a non-enumerable `filter` is left out
of the JSON the SDK signs.
**Fix:** compute the filter first, and pass it as a value:

```ts
const filter = `tenant = ${JSON.stringify(user.tenant)}`;
await tenantToken({ apiKey, apiKeyUid, indexes: [movieIndex], searchRules: { movies: { filter } }, expiresAt });
```

### `tenantToken for "movies": searchRules has a rule for "movies" that has a toJSON; give it { filter: … }, or null to search it with no filter`

**When:** a rule with a `toJSON` method. Siblings: `whose filter has a
toJSON` (an array filter carrying one), and `that has a key other than
filter` — the SDK's rule, in meilisearch-js 0.62.0, has no other key. A
bare `TypeError`, before anything is signed.
**Why:** the SDK signs `JSON.stringify` of the rule, and a `toJSON` decides
what that is: measured on v1.53.2, one returning `null` signed an unfiltered
token.
**Fix:** pass `{ filter }` alone.

### `tenantToken for "movies": searchRules has a rule for "movies" whose filter is a number; give it { filter: … }, or null to search it with no filter`

**When:** a `filter` that is not a string or an array of strings: `NaN` or
`Infinity` (`whose filter is a number`), a function, a symbol, an object
(`whose filter is an object`), a boolean (`whose filter is a boolean`), or
an array holding one of those (`whose filter holds a number`), holding
`undefined` or `null` (`whose filter holds undefined`, `whose filter holds
null`), or nested past the SDK's two levels (`whose filter holds an
array`). A bare `TypeError`,
before anything is signed.
**Why:** `JSON.stringify` writes `NaN` as `null` and leaves a function or a
symbol out: measured on v1.53.2, a `NaN` filter signed an unfiltered token.
**Fix:** build the filter as a string — `JSON.stringify` any value inside
it:

```ts
searchRules: { movies: { filter: `year > ${Number(minYear)}` } },
```

### `tenantToken for "movies": expiresAt is in the past`

**When:** `tenantToken({ …, expiresAt })` with a `Date` or a number of
seconds already past. It is a `SearchIndexError` with
`code: 'INVALID_EXPIRES_AT'`, thrown before anything is signed; `indexUid`
holds the token's uids joined by `,`.
**Why:** a past token would be refused by the server on its first search.
The message never repeats the value.
**Fix:** a `Date` in the future, or whole seconds:

```ts
expiresAt: new Date(Date.now() + 60 * 60 * 1000),
// or
expiresAt: Math.floor(Date.now() / 1000) + 3600,
```

### `tenantToken for "movies": expiresAt is not a whole number of seconds`

**When:** `expiresAt` is a number with a fraction — `Date.now() / 1000 + 60`
without `Math.floor`. `INVALID_EXPIRES_AT`, before anything is signed.
**Why:** measured on v1.53.2, a fractional `exp` makes every search with the
token fail: *Could not decode tenant token, JSON error: invalid type:
floating point …, expected i64*.
**Fix:**

```ts
expiresAt: Math.floor(Date.now() / 1000) + 3600,
```

### `tenantToken for "movies": expiresAt is an invalid Date`

**When:** `expiresAt` is a `Date` whose time is `NaN` — `new Date(value)`
from something unparseable, such as a field a request sent.
`INVALID_EXPIRES_AT`, before anything is signed.
**Why:** an invalid `Date` has no time to sign.
**Fix:** check the value where it is parsed, or build the `Date` yourself:

```ts
const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
```

### `tenantToken for "movies": expiresAt is neither a Date nor a finite number`

**When:** `expiresAt` is `NaN`, `Infinity`, or neither a `Date` nor a number
— a string from a request, say, or an object given `Date.prototype` without
being a `Date`. `INVALID_EXPIRES_AT`, before anything is signed.
**Why:** the token's `exp` is a whole number of seconds, and nothing else is
read by the server. A `Date` is read with the intrinsic
`Date.prototype.getTime`, which only a real `Date` answers: measured on
v1.53.2, an object that merely looked like one signed an `exp` the server
took as no expiry.
**Fix:** a `Date`, or whole seconds:

```ts
expiresAt: new Date(Date.now() + 60 * 60 * 1000),
// or
expiresAt: Math.floor(Date.now() / 1000) + 3600,
```

### `tenantToken for "movies": expiresAt is a Date past the year 5138; was it built from milliseconds times 1000?`

**When:** `expiresAt` is a `Date` whose time, in seconds, is past 10¹¹ —
the year 5138 — typically `new Date(Date.now() * 1000)`, a time in
milliseconds multiplied as if it were seconds. `INVALID_EXPIRES_AT`, before
anything is signed.
**Why:** the same mistake as a number is refused as milliseconds; as a
`Date`, it would sign a token that lasts some 56 000 years. The message
never holds the date.
**Fix:** build the `Date` from milliseconds:

```ts
expiresAt: new Date(Date.now() + 60 * 60 * 1000),
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

### `tenantToken for "movies_next": searchRules names "movies", which is not the uid of any of its indexes`

**When:** `tenantToken` with a `searchRules` key that is not the uid one of
its `indexes` **has** at run time. A bare `TypeError`, thrown before
anything is signed. The typical case is inside a rebuild's `fill`: its index
is `movies_next`, and a rule written for `movies` does not apply to it —
the types cannot tell, since that index's uid is typed `string`. The same
goes for an index typed as a union of uids, `cond ? movieIndex :
peopleIndex`, whose rule the types let you key by either.
**Why:** Meilisearch reads a token's rules by uid. A rule under another uid
would be dropped, and its index searched **with no filter** — so it is
refused instead.
**Fix:** key the rule by the index's own uid:

```ts
await movieIndex.rebuild(async (next) => {
	await tenantToken({ apiKey, apiKeyUid, indexes: [next], searchRules: { [next.uid]: { filter } }, expiresAt });
});
```

### `tenantToken: an index uid is not a valid Meilisearch uid (letters, digits, - and _ only), and a * in it would widen the token to other indexes`

**When:** `tenantToken` with an index whose uid is not a Meilisearch index
uid — `*`, `movies*`, an empty uid, or one with a space. Since 0.6.0
`defineIndex` and `bindIndex` refuse such a uid first, so this is left for an
index that did not come from `bindIndex`, or whose `uid` was reassigned
after it. A bare `TypeError`, before anything is signed. It names no uid.
**Why:** Meilisearch reads a token's rule keys as index **patterns**.
Measured on v1.53.2: an index bound as `*` with a `null` rule signed a token
that searched every other index. A rule keyed by a pattern beside valid
indexes is refused as an unmatched key, above.
**Fix:** sign for the index `bindIndex` returned, as it returned it; and
check a uid built from a request before defining it, as
[above](#defineindex-the-uid-must-be-1-to-400-characters-each-an-ascii-letter-a-digit---or-_).

### `tenantToken for "movies": searchRules must be a plain object`

**When:** `tenantToken` with a `searchRules` whose prototype is neither
`Object.prototype` nor `null` — `Object.create(defaults)`, or an instance of
a class. A bare `TypeError`, thrown before anything is signed.
**Why:** only a rule that is an **own** key is read. An inherited one would
be dropped, and its index searched with no filter; a class instance is
refused with it, since its prototype can hold a rule — a getter — that is
not an own key either. An object made with `Object.create(null)` is plain,
and accepted.
**Fix:** spread it into a plain object:

```ts
await tenantToken({ apiKey, apiKeyUid, indexes: [movieIndex], searchRules: { ...defaults, ...rules }, expiresAt });
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
await tenantToken({ apiKey: searchKey.key, apiKeyUid: searchKey.uid, indexes: [movieIndex], searchRules: { movies: { filter } }, expiresAt });
```

### `failed to detect a server-side environment; do not generate tokens on the frontend in production!`

The SDK's `Error` goes on: *use the `force` option to disable environment
detection, consult the documentation (Use at your own risk!)*. Read from the
SDK's source (meilisearch-js 0.62.0), not measured: the specs run on Bun,
which it recognises.

**When:** `tenantToken` in a browser, or on a server runtime whose
`navigator.userAgent` does not start with `Node`, `Deno`, `Bun` or
`Cloudflare-Workers` and that has no `process.versions.node`.
**Why:** signing needs the key, and a key in a browser is a key for anyone
who opens the page.
**Fix:** sign on the server and send the token. On a server the SDK does
not recognise, `force: true` skips the check:

```ts
await tenantToken({ apiKey, apiKeyUid, indexes: [movieIndex], searchRules: { movies: { filter } }, expiresAt, force: true });
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
**Fix:** add the index to `indexes`, with its own rule — `null` if it may be read in full:

```ts
await tenantToken({ apiKey, apiKeyUid, indexes: [movieIndex, peopleIndex], searchRules: { movies: { filter }, people: null }, expiresAt });
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
