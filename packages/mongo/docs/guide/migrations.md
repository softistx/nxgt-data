# Migrations

[`sync`](sync.md) brings the validator and the indexes in line; a migration
is for what it never does — rewriting documents. They are a list, in code,
applied in order and recorded.

```ts
import { defineMigration, migrate } from '@nxgt/mongo/migrations';

export const migrations = [
	defineMigration({
		id: '2026-09-17-posts-by-slug',
		transaction: false,   // an index build cannot run in a transaction
		async up({ db }) {
			await db.collection('posts').createIndex({ slug: 1 }, { name: 'posts_slug' });
		},
		async down({ db }) {
			await db.collection('posts').dropIndex('posts_slug');
		},
	}),
	defineMigration({
		id: '2026-09-18-backfill-slug',
		async up({ db, session }) {
			await db
				.collection('posts')
				.updateMany({ slug: null }, [{ $set: { slug: '$title' } }], { session });
		},
		async down({ db, session }) {
			await db.collection('posts').updateMany({}, { $unset: { slug: '' } }, { session });
		},
	}),
];

await migrate(db, migrations);   // { applied: [{ id, durationMs }, …], pending: [] }
```

There are no migration files and no CLI: nothing reads a directory, and there
is no binary to configure. The list is a module, and running it is a script
of yours.

## The four calls

```ts
import { migrate, migrationStatus, rollback } from '@nxgt/mongo/migrations';

await migrate(db, migrations);                    // apply what is not recorded
await migrate(db, migrations, { dryRun: true });  // { applied: [], pending: ['…'] }
await migrate(db, migrations, { to: '2026-09-17-posts-by-slug' });

await rollback(db, migrations);                   // undo the last applied one
await rollback(db, migrations, { to: '2026-09-17-posts-by-slug' });
await rollback(db, migrations, { dryRun: true });

await migrationStatus(db, migrations);
// [{ id, state: 'applied' | 'pending' | 'missing', appliedAt }]
```

`to` applies up to and including a migration; for `rollback` it undoes
everything **after** it, the last first. Without it, `rollback` undoes the
last applied migration alone. Either way, a rollback that would reach a
migration with no `down` is refused as a whole, before anything is undone.

A dry run reports what would run, and neither takes the lock nor creates the
records' collection.

## What a migration is

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `id` | `string` | — | what it is recorded under. Letters, digits, `_`, `-`, `.` and `:` |
| `up` | `(ctx) => Promise<void>` | — | what it does |
| `down` | `(ctx) => Promise<void>` | — | how to undo it. Without one it cannot be rolled back |
| `transaction` | `boolean` | `true` | `false` for what a transaction cannot hold |

```ts
interface MigrationContext {
	db: Db;
	client: MongoClient;
	/** The transaction's, or `undefined` under `transaction: false`. */
	session: ClientSession | undefined;
}
```

**The id is permanent.** It is what the migration is recorded under, so
renaming one makes it a new migration. Anything outside the allowed
characters throws when `defineMigration` runs, which is usually when the list
is imported. The order is the list's, not the ids'.

**Each migration runs in a transaction**, with its record: it is applied and
recorded, or neither. That needs a replica set, as every transaction does.
`session` is that transaction's, and **every operation has to be given it** —
MongoDB has no ambient session.

`transaction: false` is for what a transaction cannot hold — an index build,
`collMod`, a dropped collection, a write too large for one. Such a migration
that fails half-way stays half-done and is **not** recorded, so the next
`migrate` starts it over on top of what it did: write it so a second run
changes nothing more.

```ts
defineMigration({
	id: '2026-09-19-drop-legacy',
	transaction: false,
	async up({ db }) {
		// Safe to run twice: dropping a collection that is not there is fine.
		await db.collection('legacy_sessions').drop().catch(() => undefined);
	},
});
```

## The list only grows at its end

`migrate` and `rollback` refuse, before running anything, a list that lost an
applied migration or has a pending one before an applied one.
`migrationStatus` reports those two as `missing` and `pending` instead. All
three refuse a list that names an id twice.

```ts
const status = await migrationStatus(db, migrations);
const drift = status.filter((entry) => entry.state === 'missing');
if (drift.length > 0) throw new Error(`recorded but no longer listed: ${drift.map((e) => e.id)}`);
```

## Two runs never migrate at once

A run holds a lock — a document in `<collection>_lock` — renewed every third
of `lockTtlMs` while it works and timed by the **server's** clock, so hosts
whose clocks disagree still agree.

```ts
import { MigrationLockedError } from '@nxgt/mongo/migrations';

try {
	await migrate(db, migrations);
} catch (error) {
	if (error instanceof MigrationLockedError) {
		error.holder;      // how the run that holds it described itself
		error.expiresAt;   // when the lock lapses if it stops renewing
	}
	throw error;
}
```

A crashed run blocks the next one for `lockTtlMs` at most. A run whose lock
was taken over or removed throws `MigrationLockedError` ("lost its migration
lock") before its next migration, rather than writing beside another run.

A failure is a `MigrationError`: `migration` names it, `cause` holds the
original error, and the migrations before it stay applied.

## Where the records live

One document per migration — `{ _id: id, appliedAt, durationMs }` — in
`nxgt_migrations`. Another name goes to all three calls, the same each time:

```ts
const options = { collection: 'schema_history', lockTtlMs: 5 * 60_000 };
await migrate(db, migrations, options);
await rollback(db, migrations, options);
await migrationStatus(db, migrations, options);
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `collection` | `string` | `'nxgt_migrations'` | where runs are recorded; the lock is `<collection>_lock` |
| `lockTtlMs` | `number` | `60_000` | how long the lock is held without news. At least 1000 |
| `to` | `string` | — | `migrate`: up to and including. `rollback`: everything after it |
| `dryRun` | `boolean` | `false` | report, run nothing, take no lock |

## The script that runs them

```ts
import { closeMongo, connectMongo } from '@nxgt/mongo';
import { migrate, migrationStatus } from '@nxgt/mongo/migrations';
import { migrations } from './migrations';

const mongo = await connectMongo(process.env.MONGO_URL);
const dryRun = process.argv.includes('--dry-run');

const result = await migrate(mongo.db, migrations, { dryRun });
console.table(await migrationStatus(mongo.db, migrations));
console.log(dryRun ? result.pending : result.applied.map((run) => run.id));

await closeMongo();
```

Run it as a deployment step, with a credential that may write the records —
not from a request, and not from every boot of a process that has several
instances.

## A migration is refused structurally

An object shaped like a migration that did not go through `defineMigration`
compiles, and skips its id check. Two other refusals are compile errors:

```ts
// @ts-expect-error a Db, not a client
await migrate(client, migrations);
// @ts-expect-error `to` is the migration's id
await migrate(db, migrations, { to: migrations[1] });
```

## The signatures

```ts
function defineMigration(config: MigrationConfig): Migration;
function migrate(db: Db, migrations: readonly Migration[], options?: MigrateOptions): Promise<MigrateResult>;
function rollback(db: Db, migrations: readonly Migration[], options?: RollbackOptions): Promise<RollbackResult>;
function migrationStatus(db: Db, migrations: readonly Migration[], options?: MigrationStoreOptions): Promise<MigrationStatus[]>;

interface MigrateResult {
	/** What ran, in order: nothing on a dry run. */
	applied: { id: string; durationMs: number }[];
	/** What a dry run would have run, in order. */
	pending: string[];
}

interface MigrationStatus {
	id: string;
	state: 'applied' | 'pending' | 'missing';
	appliedAt: Date | undefined;
}
```

`MigrationError` and `MigrationLockedError` are exported from this subpath.
Both extend `DataError`, which is on the root — import it from there to catch
a migration failure alongside every other error of this package.

## Next

- [Sync](sync.md) — the indexes and the validator, which are not migrations.
- [Transactions](transactions.md) — the session every migration step is given.
