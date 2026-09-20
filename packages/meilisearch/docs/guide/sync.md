# Syncing the settings

`sync` brings one index in line with its [definition](definition.md) and says
what it changed. Run it at startup, in a deploy step, or as a check in CI:
run twice in a row, the second run sends nothing.

```ts
import { Meilisearch } from 'meilisearch';
import { bindIndex } from '@nxgt/meilisearch';
import { movies } from './indexes';

const client = new Meilisearch({ host: process.env.MEILI_HOST!, apiKey: process.env.MEILI_KEY });
const movieIndex = bindIndex(client, movies);

const report = await movieIndex.sync();
// { uid: 'movies', created: true, primaryKeySet: false,
//   changed: ['filterableAttributes', 'searchableAttributes', 'sortableAttributes'],
//   update: { … }, tasks: [indexCreation, settingsUpdate], dryRun: false }
```

`syncIndex(client, movies)` is the same call without binding the index, and
`syncIndexes(client, [movies, books])` syncs several in the order given — the
first that throws stops the rest.

## What it does, in order

1. **Creates the index**, with the definition's primary key, when it is
   missing. `created: true`.
2. **Gives it the primary key** when the index exists with none.
   `primaryKeySet: true`. An index that already has *another* primary key
   throws [`PRIMARY_KEY_MISMATCH`](errors.md#primary_key_mismatch); nothing is
   deleted.
3. **Reads the live settings**, compares them with the definition, and sends
   the ones that differ — and only those — in a single `updateSettings`.
4. **Waits for every task it sent**, and throws
   [`TASK_FAILED`](errors.md#task_failed) if one ends `failed` or `canceled`.

An index created by someone else between step 1 and step 2 is not an error:
`sync` goes on with theirs, whose primary key step 2 checks.

## Options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `dryRun` | `boolean` | `false` | compare and report, send nothing: no index created, no setting updated |
| `wait` | `{ timeout?: number; interval?: number }` | the SDK's (5 s) | how long to wait for each task it sends, and how often to ask |

A settings change on an index that holds many documents re-indexes it, which
takes longer than the SDK's default wait — the wait then throws
`MeilisearchTaskTimeOutError` while the task goes on in Meilisearch:

```ts
await movieIndex.sync({ wait: { timeout: 120_000, interval: 500 } });
```

A dry run is a CI check that the deployed settings are the ones in the code:

```ts
const [report] = await syncIndexes(client, [movies, books], { dryRun: true });
if (report.created || report.changed.length > 0) {
	console.error(`${report.uid} is out of date:`, report.changed);
	process.exitCode = 1;
}
```

## The report

```ts
interface SyncReport {
	uid: string;
	/** The index did not exist, and was created with its primary key. */
	created: boolean;
	/** The index existed with no primary key, and was given the definition's. */
	primaryKeySet: boolean;
	/** The settings that differed from the definition, and were updated. */
	changed: (keyof Settings)[];
	/** The settings update that was sent, or would be in a dry run: `{}` for none. */
	update: Settings;
	/** The tasks this sync waited for, in order: none when nothing changed. */
	tasks: Task[];
	dryRun: boolean;
}
```

A sync that changed nothing is exactly:

```ts
{ uid: 'movies', created: false, primaryKeySet: false, changed: [], update: {}, tasks: [], dryRun: false }
```

which is what makes `changed.length === 0` a usable assertion in a test or a
health check.

## How the comparison works

Meilisearch does not read a setting back the way it was written, so a plain
equality would resend everything on every run. `diffSettings` compares each
setting the way the server stores it:

| Setting | Compared |
| --- | --- |
| `searchableAttributes`, `displayedAttributes`, `rankingRules` | in order — the order is part of their meaning |
| every other list (`sortableAttributes`, `stopWords`…) | as a set: the server stores them sorted |
| `typoTolerance`, `faceting`, `pagination`, `embedders` | by the fields the definition sets; the server fills the rest with defaults |
| the rest | by value |

An embedder's `apiKey` is skipped, because Meilisearch reads it back masked
and it would never match: a new key alone is not sent. Change it with
`movieIndex.raw.updateEmbedders`.

The comparison is exported on its own, for two settings objects of your own —
comparing an index with another, or a backup with the server:

```ts
import { diffSettings } from '@nxgt/meilisearch';

const live = await client.index('movies').getSettings();
const staging = await client.index('movies_staging').getSettings();

const update = diffSettings(staging, live);
console.log(Object.keys(update)); // [] when live already holds everything staging sets
```

```ts
function diffSettings(wanted: WantedSettings, live: Settings): Settings;
```

`wanted` is a `WantedSettings`: the settings as something *wants* them, with
every list `readonly`. That is how a definition holds its own — `defineIndex`
infers `sortableAttributes: ['year']` as `readonly ['year']`, which is what
makes `SortableOf` and the typed `sort` work — so a definition goes in
directly:

```ts
import { diffSettings } from '@nxgt/meilisearch';

const live = await client.index('movies').getSettings();
const update = diffSettings(movies.settings, live); // the definition itself
```

A plain, mutable `Settings` from anywhere else still goes in, and what comes
back is a `Settings` the SDK will take:

```ts
await client.index('movies').updateSettings(diffSettings(movies.settings, live));
```

`live` stays the SDK's own `Settings`, because that is what the server hands
back. A definition that sets no settings has no `settings` property at all —
there is nothing to compare, and `sync` leaves that index's settings alone. For "what would `sync` change?" without writing any of this,
`syncIndex(client, movies, { dryRun: true })` gives the same diff as its
`update`.

A setting `wanted` leaves out is never compared, and never sent.

## At startup

One module that the rest of the app imports: the client, the sync, the bound
indexes.

```ts
import { Meilisearch } from 'meilisearch';
import { bindIndex, syncIndexes } from '@nxgt/meilisearch';
import { books, movies } from './indexes';

export const client = new Meilisearch({
	host: process.env.MEILI_HOST!,
	apiKey: process.env.MEILI_KEY,
	defaultWaitOptions: { timeout: 30_000 },
});

export const movieIndex = bindIndex(client, movies);
export const bookIndex = bindIndex(client, books);

/** Called once, before the server accepts traffic. */
export async function syncSearch() {
	const reports = await syncIndexes(client, [movies, books], { wait: { timeout: 120_000 } });
	for (const report of reports) {
		if (report.created || report.changed.length > 0) {
			console.info(`search: ${report.uid} updated`, report.changed);
		}
	}
}
```

The key `sync` needs may create indexes and change settings:
`indexes.create`, `indexes.get`, `indexes.update`, `settings.get`,
`settings.update` and `tasks.get`. Searching needs none of those — a
search-only key is enough for [the search page](search.md).

## Signatures

```ts
function syncIndex(
	client: Meilisearch,
	definition: AnyIndexDefinition,
	options?: SyncOptions,
): Promise<SyncReport>;

function syncIndexes(
	client: Meilisearch,
	definitions: readonly AnyIndexDefinition[],
	options?: SyncOptions,
): Promise<SyncReport[]>;

interface SyncOptions { dryRun?: boolean; wait?: WaitOptions }
```

`TypedIndex.sync(options?)` is `syncIndex` for the definition it was bound
with.
