# Syncing

`kit.sync()` brings the server in line with the definitions the kit wires:
the collections, their `$jsonSchema` validators, their collection options and
their indexes, database by database.

```ts
import { createKit, defineConfig } from '@nxgt/mongo-kit';
import * as collections from './models'; // every `defineCollection` of the app

await using kit = await createKit(
	defineConfig({ uri: process.env.MONGO_URI!, collections }),
);

const reports = await kit.sync();
// { default: [ { name: 'posts', created: true, … }, { name: 'users', … } ] }
```

It reports one `SyncReport[]` per database, under the name the config gave it
— `default` when it named none. Run it twice and the second run sends
nothing.

It leaves [buckets](files.md) alone: a bucket is not a collection
definition. Their indexes are `kit.syncBuckets()`'s, the step to run beside
this one:

```ts
await kit.sync();
await kit.syncBuckets();   // { default: { avatars: [ … ], uploads: [ … ] } }
```

## Options

They are `@nxgt/mongo`'s `SyncOptions`, passed through as they are.

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `dryRun` | `boolean` | `false` | Compare and report, send nothing. An option MongoDB cannot change is reported instead of thrown, so one run lists everything that is wrong |
| `dropUnknownIndexes` | `boolean` | `false` | Drop the indexes the server has and no definition names. `_id_` is never dropped |
| `session` | `ClientSession` | — | A session for the reads. Never one in a transaction: MongoDB allows neither `collMod` nor an index build inside one |

```ts
const reports = await kit.sync({ dryRun: true });
reports.default[0]?.created;          // what it would create
reports.default[0]?.indexes.created;  // the indexes it would build
```

The first database that throws stops the rest, which is what `dryRun` is
for: it reports everything at once.

## It is a deployment step

`collMod` needs the `dbAdmin` role, and an index build runs outside any
transaction — neither belongs in a request. A script of its own, run before
the new version serves traffic:

```ts
// src/sync.ts — `bun run src/sync.ts [--dry-run]`
import { createKit } from '@nxgt/mongo-kit';
import { config } from './db';

await using kit = await createKit(config);

const reports = await kit.sync({ dryRun: process.argv.includes('--dry-run') });
for (const [database, collections] of Object.entries(reports)) {
	for (const report of collections) {
		console.log(
			`${database}.${report.name}: ${report.created ? 'created' : 'in place'}, ` +
				`${report.indexes.created.length} index(es) created`,
		);
	}
}
```

For tests and local development, `autoSync: true` in the
[configuration](configuration.md) syncs each collection before its first
operation instead, and no script is needed.

## Why not `syncAll`

`@nxgt/mongo`'s `syncAll` works from a global registry, which knows no
database: it cannot tell the collections of one from those of another.
`kit.sync()` syncs exactly what the kit wires, on the database each one is
wired to. For a repository that has no kit — a migration script, a one-off —
[`discoverCollections`](discover-collections.md) with `syncCollections` is
the other way round.

## Signatures

```ts
interface MongoKit<C> {
	sync(options?: SyncOptions): Promise<Record<DbName<C>, SyncReport[]>>;
}

// both from @nxgt/mongo
interface SyncOptions {
	dryRun?: boolean;
	dropUnknownIndexes?: boolean;
	session?: ClientSession;
}

interface SyncReport {
	name: string;
	created: boolean;
	validator: 'unchanged' | 'created' | 'updated' | 'removed';
	options: { changed: string[]; immutable: OptionMismatch[] };
	indexes: { created: string[]; recreated: string[]; dropped: string[]; unchanged: string[] };
	dryRun: boolean;
}
```

## Next

- [`discoverCollections`](discover-collections.md) — syncing from a glob,
  without a kit.
- [Configuration](configuration.md) — `autoSync`, and the options a
  collection is built with.
