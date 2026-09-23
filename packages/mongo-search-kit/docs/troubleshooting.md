# Troubleshooting

Every heading is the text the error prints, so the page can be searched with
what you have in front of you. Stacks, ids and paths are cut, and a sync's
name is written as it comes out by default — `<collection>:<index uid>`, here
`articles:articles`.

Each sync is [`@nxgt/mongo-meilisearch`](https://www.npmjs.com/package/@nxgt/mongo-meilisearch)'s,
unchanged, so its errors are this package's errors: a `SearchSyncError` with a
`code` (`HISTORY_LOST`, `ID_MISMATCH`, `NOT_A_DOCUMENT`, `RUNNING`,
`LEASE_LOST`, `FAILED`), the sync's `name`
and the original error as `cause`. **Its own `docs/troubleshooting.md` covers
the transform, the ids, the resume point and the privileges a sync needs**;
what is below is what this kit adds — the config, and the syncs started and
stopped together.

| Area | Entries |
| --- | --- |
| [Install](#install) | [ERESOLVE](#npm-error-eresolve-unable-to-resolve-dependency-tree) · [incorrect peer dependency](#warn-incorrect-peer-dependency-nxgtmongo-kit010) · [TS2307](#error-ts2307-cannot-find-module-nxgtmongo-meilisearch-or-its-corresponding-type-declarations) |
| [Types](#types) | [a key the kit does not wire](#mongo-search-kit-this-kit-wires-no-collection-called-comments) |
| [Configuration](#configuration) | [the same, at run time](#createsearchkit-this-kit-wires-no-collection-called-comments) · [several databases](#createsearchkit-this-kit-holds-2-databases-main-analytics-and-a-search-kit-follows-the-collections-of-one) |
| [Starting](#starting) | [no replica set](#search-sync-articlesarticles-failed-starting-the-changestream-stage-is-only-supported-on-replica-sets) · [started twice](#search-sync-articlesarticles-is-already-following-changes-in-this-process-close-it-before-you-start-it-twice) · [held by another process](#search-sync-articlesarticles-is-held-by--until--wait-for-it-to-close-or-for-its-lease-to-lapse-before-you-start-it) · [the lease lost](#search-sync-articlesarticles-lost-its-lease-another-process-holds-the-name-now-or-the-lease-was-removed-it-lapses-when-not-renewed-within-30000-ms-it-stopped-rather-than-run-beside-it) · [a partial reindex](#search-sync-authorsauthors-failed-reindexing-) |
| [While running](#while-running) | [a silent failure](#one-index-stops-updating-and-nothing-is-thrown) · [`failed` never resolves](#await-runningfailed-never-resolves) · [a dropped collection is silent](#a-sync-stops-and-nothing-settles) |
| [Stopping](#stopping) | [`close()` rejects](#closing-rejects-with-an-error-failed-never-reported) |

## Install

### `npm error ERESOLVE unable to resolve dependency tree`

```
npm error Found: @nxgt/mongo-kit@0.1.3
npm error Could not resolve dependency:
npm error peer @nxgt/mongo-kit@"^0.1.4" from @nxgt/mongo-search-kit@0.1.4
```

**When:** `npm install`, before anything is downloaded.

**Why:** this package is built on four **required peers** —
`@nxgt/mongo-kit`, `@nxgt/mongo-meilisearch`, `@nxgt/mongo` and
`@nxgt/meilisearch` — and every range is a caret on a 0.x version, so each
accepts one minor only. The kit hands over the collections and the bridge
builds the syncs: all of them have to be the copies this version was built
against. `mongodb`, `meilisearch` and `typescript` are peers on the same terms.

**Fix:** install the four together, at the versions the manifest asks for:

```sh
npm install @nxgt/mongo-search-kit @nxgt/mongo-kit @nxgt/mongo-meilisearch @nxgt/mongo @nxgt/meilisearch mongodb meilisearch zod
```

`npm view @nxgt/mongo-search-kit peerDependencies` prints the exact ranges for
the version you are on. Do not install past the conflict with `--force` or
`--legacy-peer-deps`: two copies of `@nxgt/mongo-kit` in one tree means the
collections you configure are not the ones the syncs read.

### `warn: incorrect peer dependency "@nxgt/mongo-kit@0.1.0"`

**When:** `bun install`, which prints it and carries on.

**Why:** bun does not fail on an unmet peer — it warns and installs what the
manifest asked for. Of the four peers here, the one that bites first is
`@nxgt/mongo-kit`: the config's keys are read off the kit's sole database, so
an older kit gives a type that no longer matches, or a `kit.db` shape this
package does not recognise.

**Fix:**

```sh
bun add @nxgt/mongo-kit @nxgt/mongo-meilisearch @nxgt/mongo @nxgt/meilisearch
```

Treat that warning as an error. `bun pm ls` shows which versions were resolved.

### `error TS2307: Cannot find module '@nxgt/mongo-meilisearch' or its corresponding type declarations.`

At run time the same tree gives
`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@nxgt/mongo-meilisearch'`
under Node, and `error: Cannot find module '@nxgt/mongo-meilisearch'` under
Bun.

**When:** the first build or the first import of your own code, typically
under pnpm or npm with a strict `node_modules` layout.

**Why:** a peer installed *for* this package is not a dependency of **yours**.
It is resolved under the search kit alone, so
`@nxgt/mongo-search-kit` finds it and your own
`import type { ReindexReport } from '@nxgt/mongo-meilisearch'` does not.

**Fix:**

```sh
bun add @nxgt/mongo-search-kit @nxgt/mongo-kit @nxgt/mongo-meilisearch @nxgt/mongo @nxgt/meilisearch mongodb meilisearch zod
```

Declare every peer you import from yourself: `bindIndex` and `defineIndex` are
`@nxgt/meilisearch`'s, the options and the report types are the bridge's.

## Types

### `mongo-search-kit: this kit wires no collection called "comments"`

The whole line is a `TS2322`:

```
error TS2322: Type 'TypedIndex<IndexDefinition<…>>' is not assignable to type
'"mongo-search-kit: this kit wires no collection called \"comments\""'.
```

**When:** compiling the `createSearchKit` call. The refusal lands on that
entry's `index`, which is why the message reads as a type. A key the kit
wires as a GridFS **bucket** is refused the same way: a bucket is not a
collection, and has nothing to follow.

**Why:** a config key is the name a collection is **exported** under — the same
key `kit.db.<key>` answers to. `comments` is not one of them: either the model
is not exported from the module the kit's config passes as `collections`, or
the export was renamed.

**Fix:** use the kit's own key:

```ts
const search = createSearchKit(kit, {
	articles: { index: bindIndex(meili, articleIndex), transform: toArticleHit },
	//  ^ `kit.db.articles`, so `export const articles = defineCollection(…)`
});
```

A key that is a member of the driver's `Db` — `command`, `watch` — is refused
the same way: `@nxgt/mongo-kit` never wires a collection under one of those.

## Configuration

### `createSearchKit: this kit wires no collection called "comments"`

**When:** calling `createSearchKit`, when the types were bypassed — an `as
never`, a config built at run time, or JavaScript.

**Why:** the same cause as the
[type error above](#mongo-search-kit-this-kit-wires-no-collection-called-comments).
It is checked again at run time because a `Db` answers to its own members: a
key that is one would give something that is not a collection rather than
`undefined`. The same holds for a key the Mongo kit wires a **GridFS bucket**
under (`@nxgt/mongo-kit` 0.4.0 and later): a bucket sits on the scope beside
the collections, but there is nothing in it to search.

**Fix:** write the config as a literal argument to `createSearchKit`, so the
compiler refuses it first — a config assigned to a variable of a wider type
loses the refusal.

### `createSearchKit: this kit holds 2 databases (main, analytics), and a search kit follows the collections of one`

The message ends: *Build one search kit per database, from a kit that wires
that database alone*.

**When:** calling `createSearchKit` with a kit built from a `databases` config.

**Why:** the config's keys come from the kit's **sole** database, the same way
`kit.db` does. With several there is no sole one, so the key type is already
`never` — this is what the call gets at run time.

**Fix:** build one kit per database, and one search kit over each:

```ts
const mainKit = await createKit(defineConfig({ uri, collections }));
const search = createSearchKit(mainKit, {
	articles: { index: bindIndex(meili, articleIndex), transform: toArticleHit },
});
```

## Starting

### `Search sync "articles:articles" failed starting: The $changeStream stage is only supported on replica sets`

Code `FAILED`; the `cause` is the driver's `MongoServerError`, code 40573.

**When:** `search.start()`, against a standalone `mongod`. The syncs already
started are closed before it comes back, so nothing is left running.

**Why:** every sync follows its collection with a change stream, and MongoDB
serves change streams on a replica set or a sharded cluster only.

**Fix:** run a replica set — a single node is enough:

```sh
mongod --replSet rs0 --dbpath ./data   # then, once: rs.initiate()
```

### `Search sync "articles:articles" is already following changes in this process: close it before you start it twice.`

Code `RUNNING`. `reindexAll()` while the kit is running ends
`… before you reindex.`

**When:** a second `start()` on the same search kit, or a `reindexAll()` while
it is running.

**Why:** a reindex removes what the index holds and the collection no longer
gives it — including what the running follower has just indexed, which it will
never send again. The refusal is the bridge's, passed through, and is the sync
object's own. Another process, or a second search kit over the same
collections in this one, is refused by the lease on the sync's name instead,
with
[`… is held by …`](#search-sync-articlesarticles-is-held-by--until--wait-for-it-to-close-or-for-its-lease-to-lapse-before-you-start-it).

**Fix:** close before reindexing or starting again:

```ts
const running = await search.start();
// …
await running.close();
await search.reindexAll();
```

### `Search sync "articles:articles" is held by … until …: wait for it to close, or for its lease to lapse, before you start it.`

Code `RUNNING`. The holder is written `<host>:<pid>:<24 hex digits>`, and the
date is ISO, in UTC. From `reindexAll()` it ends `… before you reindex.`

**When:** `start()` or `reindexAll()`, while another process — or another
search kit in this one — follows or reindexes the same sync name. Also after a
process that held it died without closing, until its lease lapses (`leaseMs`,
default `30000`). `start()` closes the syncs it had already started before
this comes back.

**Why:** each sync takes a lease on its name, and the bridge's lease is what
keeps two followers off one name. Its full entry is the bridge's:
[`… is held by …`](https://github.com/softistx/nxgt-data/blob/develop/packages/mongo-meilisearch/docs/troubleshooting.md#search-sync-articlesarticles-is-held-by--until--wait-for-it-to-close-or-for-its-lease-to-lapse-before-you-start-it).

**Fix:** run one kit per set of names, and let a second replica wait and retry
`start()`:

```ts
import { SearchSyncError } from '@nxgt/mongo-meilisearch';

// Another process holds a name, or took one over while this start reindexed.
const heldElsewhere = (error: unknown) =>
	error instanceof SearchSyncError &&
	(error.code === 'RUNNING' || error.code === 'LEASE_LOST');

async function follow() {
	for (;;) {
		try {
			return await search.start();
		} catch (error) {
			if (!heldElsewhere(error)) throw error;
			await new Promise((resolve) => setTimeout(resolve, 10_000));
		}
	}
}

const running = await follow();
```

Two search kits over one collection share the name, because it defaults to
`<collection>:<index uid>` — and with it the recorded point and the lease. Give
`name` per entry if you mean them to be different:

```ts
createSearchKit(kit, {
	articles: { index, transform, name: 'articles-secondary' },
});
```

### `Search sync "articles:articles" lost its lease: another process holds the name now, or the lease was removed (it lapses when not renewed within 30000 ms). It stopped rather than run beside it.`

Code `LEASE_LOST`; the number is that entry's `leaseMs`.

**When:** while running, `failed` rejects with it once a renewal finds the
lease taken over — the process stalled for longer than `leaseMs`, or the lease
was deleted by hand. `reindexAll()` and `start()` reject with it when a sync's
reindex finds the lease lost: that reindex has recorded nothing, and has
removed nothing unless the lease went while the removal itself ran; the pages
it already sent stay in the index. `start()` closes the syncs it had already
started before it comes back.

**Why:** another process may be following that name now, and the sync stops
rather than run beside it. The full entry is the bridge's:
[`… lost its lease …`](https://github.com/softistx/nxgt-data/blob/develop/packages/mongo-meilisearch/docs/troubleshooting.md#search-sync-articlesarticles-lost-its-lease-another-process-holds-the-name-now-or-the-lease-was-removed-it-lapses-when-not-renewed-within-30000-ms-it-stopped-rather-than-run-beside-it).

**Fix:** give `leaseMs` room above the longest pause a process may take, and
start again — the retry loop above waits while the new holder runs:

```ts
createSearchKit(kit, {
	articles: { index, transform, leaseMs: 120_000 },
});
```

### `Search sync "authors:authors" failed reindexing: …`

**When:** `reindexAll()`, on the first key that fails. The keys after it in the
config are not run, and the reports of the keys already done are **lost with
the rejection**.

**Why:** a reindex removes what a collection no longer gives, so a half-finished
run is not a state to carry on from. The error names the sync that stopped it;
what it stopped on is its `cause`.

**Fix:** read the error, fix it, and run it again — the reindexes that succeeded
are idempotent:

```ts
try {
	await search.reindexAll();
} catch (error) {
	log.error(error);            // `error.sync` names the key that failed
	throw error;
}
```

For a report per key whatever happens, reindex the syncs one at a time through
`search.syncs`:

```ts
for (const [key, sync] of Object.entries(search.syncs)) {
	const report = await sync.reindex().catch((error: unknown) => error);
	log.info({ key, report });
}
```

## While running

### One index stops updating, and nothing is thrown

The error that stopped it is
`Search sync "articles:articles" failed following changes: boom`, and it is
never printed: nothing in your process asked for it.

**When:** while the kit is running, after one sync stops on an error — a
transform that threw, a batch Meilisearch refused, a server that went away.
The other syncs carry on, so the symptom is one index falling behind.

**Why:** `failed` is a promise that **rejects** with the first sync that stops.
The kit takes every rejection it makes so that none of them ends the process —
each sync's own `closed`, and `failed` itself — which means a failure nobody
took is a failure nobody hears about. `close()` will not report it either: it
deliberately stays quiet about the one `failed` carried.

**Fix:** take `failed` the moment you have it:

```ts
const running = await search.start();
running.failed.catch((error: unknown) => {
	log.error(error);
	void shutdown();
});
```

Or race it against your own shutdown, which is the other shape:

```ts
await Promise.race([running.failed, stopSignal]);
await running.close();
```

### `await running.failed` never resolves

Not an error: the line simply never returns.

**When:** awaiting `failed` after a clean `close()`, or on a kit where nothing
goes wrong.

**Why:** `failed` rejects on the first failure and **never resolves**: a clean
stop is not an event, so there is nothing for it to settle with.

**Fix:** use it for `catch`, or race it — never as the last `await` of a
shutdown:

```ts
running.failed.catch(exit);     // handled, not awaited
await running.close();          // this is what resolves when the kit stops
```

### A sync stops and nothing settles

**When:** the collection behind one sync is dropped or renamed while the kit
is running.

**Why:** the bridge treats an invalidated change stream as a **clean stop** —
that sync's `closed` *resolves* with `'invalidated'` — and this kit forwards
failures only. So `failed` stays quiet, `close()` throws nothing, and that one
sync is dead while the others carry on.

**Fix:** watch the sync's own `closed` when a drop has to be noticed:

```ts
const running = await search.start();
for (const [key, one] of Object.entries(running.running)) {
	one.closed.then((reason) => {
		if (reason === 'invalidated') log.warn({ key }, 'collection dropped');
	}, () => undefined);          // failures are `failed`'s to report
}
```

What the collection holds after it is recreated is indexed by the reindex the
next `start()` runs for that sync.

## Stopping

### Closing rejects with an error `failed` never reported

**When:** `await running.close()` — including the implicit one of
`await using` — after something has already gone wrong.

**Why:** `close()` deliberately swallows the failure `failed` already carried,
so you do not have to hear the same error twice. Every **other** failure is
thrown: a second sync that fell over after `failed` had settled, and anything
that goes wrong while closing — the last flush of a sync that cannot reach
Meilisearch, for one. If more than one throws, `close()` reports the first.

**Fix:** handle both, and treat `close()` as able to fail:

```ts
const running = await search.start();
running.failed.catch((error: unknown) => log.error(error)); // the first failure
try {
	await running.close();
} catch (error) {
	log.error(error);            // a second one, or a failure while closing
}
```

`close()` is idempotent, and it keeps going past a sync that fails, so the
others are still flushed and stopped. The Mongo kit is **not** closed with it:
`kit.close()` stays yours to call.
