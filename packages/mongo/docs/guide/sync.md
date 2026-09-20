# Sync

`sync` puts a [definition](collections.md) on the server: it creates the
collection with its validator, writes the validator when it changed, creates
the indexes that are missing, and rebuilds those whose options changed. Run
it twice and the second run sends nothing.

```ts
import { syncCollections } from '@nxgt/mongo';
import { posts, users } from './collections';

const reports = await syncCollections(db, [users, posts]);
// [{ name: 'users', created: true, validator: 'created',
//    options: { changed: [], immutable: [] },
//    indexes: { created: ['users_email_unique'], recreated: [], dropped: [], unchanged: [] },
//    dryRun: false }, …]
```

It is a deployment step, not a request-time one: writing a validator runs
`collMod`, which needs the `dbAdmin` role that an application's own user
usually does not have, and neither it nor an index build may run inside a
transaction.

## Every collection at once

Defining a collection registers it, so `syncAll` needs no list anyone has to
keep up to date — importing the module that defines a collection is what puts
it in:

```ts
import { syncAll } from '@nxgt/mongo';
import './collections';            // the definitions

const reports = await syncAll(db);
```

It covers every definition the process has loaded. When one process holds the
collections of several databases, sync each database's own list with
`syncCollections(db, [users, posts])` instead.

One collection at a time is `syncCollection(db, definition)`, or
`collection.sync()` on a bound collection.

## The options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `dryRun` | `boolean` | `false` | compare and report, send nothing — and list every immutable difference instead of throwing on the first |
| `dropUnknownIndexes` | `boolean` | `false` | drop the indexes the server has and no definition names. `_id_` is never dropped |
| `session` | `ClientSession` | — | a session for the reads. Not one in a transaction: MongoDB refuses `collMod` and index builds there |

```ts
// What a deploy would do, without doing it:
const plan = await syncCollections(db, [users, posts], { dryRun: true });
if (plan.some((report) => report.options.immutable.length > 0)) {
	throw new Error('a collection option changed that MongoDB cannot change');
}
```

## What a report says

```ts
interface SyncReport {
	name: string;
	/** The collection did not exist, and was created. */
	created: boolean;
	validator: 'unchanged' | 'created' | 'updated' | 'removed';
	options: {
		/** Those `collMod` changed, by name: `capped.size`, `expireAfterSeconds`. */
		changed: string[];
		/** Those MongoDB cannot change. Outside `dryRun` this is always empty: sync throws. */
		immutable: OptionMismatch[];
	};
	indexes: {
		created: string[];
		/** There with other options: dropped and built again. */
		recreated: string[];
		dropped: string[];
		unchanged: string[];
	};
	dryRun: boolean;
}
```

## The validator

`validation: { level: 'off' }` on the definition writes no validator at all,
and removes one that is already there. `{ action: 'warn' }` logs a document
that fails instead of refusing it, which is how a validator is rolled out
onto a collection that is already full. Existing documents are never checked
until they are modified.

## Options MongoDB cannot change

Most collection options are decided once. `sync` changes the few `collMod`
accepts — `capped.size`, `capped.max`, `expireAfterSeconds`, a time series'
granularity and bucket spans, `changeStreamPreAndPostImages` — and **throws**
on the rest, naming the option, what the collection has, and what the
definition asks for:

```
sync: "logs" already exists with options MongoDB cannot change:
  capped: the collection has null, the definition asks for true
```

Making an existing collection capped, its collation and its clustered index
are among those. `dryRun: true` lists every difference at once instead of
throwing on the first.

Only what the definition actually asks for is compared, which is also why a
sync of an unchanged collection sends nothing: MongoDB fills its own defaults
in — a `collation: { locale: 'fr' }` comes back with eleven keys and a
`version` — and comparing those for equality would report a difference every
single time.

## Rebuilding an index drops it first

MongoDB cannot alter an index in place, so an index whose options changed is
dropped and created again: there is a window with no index, and on a large
collection the rebuild is not free. The report tells them apart —
`indexes.recreated` rather than `indexes.created`.

## Syncing from the collection

`autoSync` syncs once per database, before the first operation:

```ts
import { getCollection, resetAutoSync } from '@nxgt/mongo';

const collection = getCollection(db, users, { autoSync: true });
await collection.create({ email: 'ada@example.com' });   // the collection is there
```

It is **not** for production, for the reasons above. Only this package's own
methods wait for it — `raw` and the driver's own methods are the escape
hatch, and the escape hatch is not managed.

The memo is per database and survives a `dropDatabase`, which is what makes
it sync once rather than before every call. A test that drops its database
between cases calls `resetAutoSync(db)` alongside, or the next case would
think a collection it can no longer see is still in shape.

```ts
import { beforeEach } from 'bun:test';
import { resetAutoSync } from '@nxgt/mongo';

beforeEach(async () => {
	await db.dropDatabase();
	resetAutoSync(db);        // resetAutoSync() with no argument forgets every database
});
```

A bucket keeps a memo of its own: `resetBucketSync(db)`, from
[`@nxgt/mongo/gridfs`](gridfs.md#create-the-indexes).

## A deploy script

```ts
import { closeMongo, connectMongo, syncAll } from '@nxgt/mongo';
import './collections';

const mongo = await connectMongo(process.env.MONGO_URL);   // the dbAdmin credential
const reports = await syncAll(mongo.db, { dryRun: process.argv.includes('--dry-run') });

for (const report of reports) {
	console.log(report.name, report.validator, report.indexes.created.join(', '));
}
await closeMongo();
```

The first collection that throws stops the rest, so a dry run is the way to
see everything that is wrong at once.

## The signatures

```ts
function syncCollection(db: Db, definition: AnyCollectionDefinition, options?: SyncOptions): Promise<SyncReport>;
function syncCollections(db: Db, definitions: readonly AnyCollectionDefinition[], options?: SyncOptions): Promise<SyncReport[]>;
function syncAll(db: Db, options?: SyncOptions): Promise<SyncReport[]>;
function resetAutoSync(db?: Db): void;

function registeredCollections(): AnyCollectionDefinition[];
function clearCollectionRegistry(): void;
```

`diffIndexes`, `normalizeIndex`, `indexMatches`, `validationMatches`,
`hasValidator`, `diffCollectionOptions` and `collModForOptions` are the
pieces `sync` compares with, exported for a tool of your own.

## Next

- [Collections](collections.md) — the indexes, the validator and the options
  that are being synced.
- [Migrations](migrations.md) — for what `sync` never does: rewriting
  documents.
