# AGENTS.md

Instructions for any coding agent working in `nxgt-data`.

## What this repository is

The `@nxgt/*` packages for data access, published to the public npm
registry:

| package | what it is |
| --- | --- |
| `@nxgt/drizzle` | an SDK over Drizzle ORM: typed repositories (`createRepository`), offset and cursor pagination, `withTransaction`, `upsert` as one `INSERT … ON CONFLICT` on the `where`'s columns, optimistic locking on an integer `NOT NULL` `version` (`OptimisticLockError`), actor stamps from `as(actor)` or the `actor` option, its own errors with `toDataError`, and the `id()`, `timestamps()`, `softDelete()`, `version()`, `actors()` columns. PostgreSQL first |
| `@nxgt/drizzle-meilisearch` | keeps a Meilisearch index in step with a PostgreSQL table: `createSearchSync` with a `transform` and a `toIndexId` typed by both sides, `reindexAll`, and one call per write — `indexRow`, `indexRows`, `removeRow`, `remove`, `removeMany`. Deliberately smaller than the Mongo bridge: PostgreSQL has no change feed a library could follow without owning the deployment, so there is no `start`, no resume point and nothing followed. Its one error is `SearchSyncError` |
| `@nxgt/meilisearch` | a typed Meilisearch index on the official SDK: `defineIndex<Doc>()({ uid, primaryKey, settings })`, `syncIndex`/`syncIndexes` applying the settings idempotently, and `bindIndex` for typed documents and searches, with `rebuild` filling `<uid>_next` beside the live index and swapping it in atomically, `multiSearch` returning a tuple of results each typed by its own index, and `tenantToken` signing a token whose `searchRules` are keyed by the uids of the bound indexes it is given, over the SDK's `meilisearch/token`. Its one error is `SearchIndexError` |
| `@nxgt/mongo` | a typed MongoDB collection from one Zod schema: `defineCollection` with its stamps and MongoDB's own collection options, `syncCollection`/`syncAll` applying the `$jsonSchema` validator, the collection options and the indexes idempotently, `getCollection` returning the driver's own `Collection` merged with pagination, soft delete, optimistic locking and audit stamps, `withTransaction`, `upsert` as one atomic pipeline update, migrations in code under the `./migrations` subpath, and files under `./gridfs` — a bucket described once, typed metadata, `Range`-aware serving, and chunk documents written by the package itself so that a file write can run in a transaction, which the driver's GridFS cannot. A string that arrives from outside is converted from the **schema** — a 24-hex string to `ObjectId` where the schema says `objectId()`, a date string to `Date` where it says `z.date()`, in ids, filters and writes alike — unless `coerce: false`. Its errors are `DataError` and its subclasses |
| `@nxgt/mongo-meilisearch` | keeps a Meilisearch index in step with a MongoDB collection: `createSearchSync` with a `transform` typed by both definitions, `reindex`, and `start`, which follows the collection's changes in batches from a resume point kept in MongoDB. Its one error is `SearchSyncError` |
| `@nxgt/mongo-kit` | an application's MongoDB wiring in one object: `defineConfig` checking a configuration of one or several databases, and `createKit` giving a `db` that is the driver's `Db` with every `@nxgt/mongo` collection typed on it — and every `@nxgt/mongo/gridfs` bucket the config's `buckets` wires, beside them, in the kit's session so a file write joins a transaction — plus the actor, the session, transactions, `sync`, `syncBuckets` (bucket indexes, which `sync` leaves alone), `ping` and `close`. `discoverCollections` reads definitions from a glob, for scripts |
| `@nxgt/mongo-search-kit` | a search kit over the wiring kit: `createSearchKit(kit, config)` takes one entry per collection — an index and a transform, under the key the kit wires that collection under — and gives one `reindexAll`, one `start` and one `close` for all of them. Each entry's sync is `@nxgt/mongo-meilisearch`'s, unchanged |
| `@nxgt/redis` | Redis on Bun's own `RedisClient`, with no third-party driver: `connectRedis`/`closeRedis` sharing one client per URI, `defineCache`/`bindCache` with the key built by a typed function and the value checked by its schema both ways, `withLock` over `SET NX PX` released by a compare-and-delete script, and `defineChannel`/`publish`/`subscribe` typed the same way. Its one error is `RedisError` |
| `@nxgt/redis-kit` | an application's Redis wiring in one object: `defineConfig` checking a configuration of one or several Redis instances, and `connectKit` opening the clients and giving `kit.cache.<key>` and `kit.channels.<key>` — every `@nxgt/redis` cache and channel typed under the key it is exported as, renamed under the instance's prefix — plus the subscriptions it tracks and closes, `lock`, `ping` and `close`. It has no error of its own: its refusals are bare `TypeError`s, and what a caller catches at run time is `@nxgt/redis`'s `RedisError` |
| `@nxgt/s3` | S3 on Bun's own `S3Client`, with no AWS SDK: `defineBucket` naming the bucket, the key-building function, the content types and the maximum size, and `bindBucket` giving `put`/`bytes`/`text`/`exists`/`stat`/`delete`, a `list` in this repository's cursor shape, and `presignGet`/`presignPut`/`presignPost` from the same definition. The content type and the size are refused **before** the request goes out; `presignPost` signs an S3 POST policy itself (SigV4, `node:crypto` — Bun has no POST presigning), so the **service** holds a browser upload to a size range and a content type. Its one error is `S3Error` |

`examples/` holds applications, not packages: they are `private`, unscoped,
and the release scripts never see them — `publish.ts` and
`verify-artifacts.ts` both glob `packages/*/package.json`. They are workspace
members, so one `bun install` covers them and biome lints them, and the root
`typecheck` and `test` run theirs after the packages'. An example that no
longer compiles is a failure like any other: that is the whole point of
keeping them in the workspace.

| example | what it shows |
| --- | --- |
| `examples/hono-api` | a Hono API on `@nxgt/mongo-kit`, its routes generated from an OpenAPI spec by `@nxgt/openapi-codegen` (nxgt-http) and bound by `@nxgt/openapi-hono`. Laid out **by module**, not by layer: `src/modules/users/` holds `users.model.ts`, `users.service.ts` and `users.route.ts`, and a module **exports** its own `Hono` as `router` rather than being handed one — `src/api.ts` is the shared registry, `tag` bounds each module to its own operations, `src/modules/index.ts` is the one list of what is mounted, `src/middlewares/` holds what every request goes through, and `app.ts` only assembles the two. A service is a **class whose constructor takes the kit**, the middleware builds one per request on `kit.as(actor)` and puts them on the context, so a handler never reaches the kit. Its write methods take the **validated body** the spec declares (`NewUser`, `NewArticle`, `UserPatch`, `ArticlePatch`), not the stored document, so a field the API does not offer cannot reach a write from a handler — `test/types/routes.ts` pins that. The environment is parsed once with zod in `src/env.ts`, its names declared in a root `bun.d.ts`, and read nowhere else; `src/index.ts` serves with `Bun.serve` on the parsed port. A `PATCH` whose `updatedAt`/`updatedBy` are the collection's, a transaction across two collections, `sync()` as a deployment step, and a spec beside each file it measures: every module has both a service spec, with no HTTP at all, and a route spec over a mongod in memory, and `app.spec.ts` keeps only what is left — the middleware, and that the mounted modules serve the whole spec |

It was started on 2026-09-15, on the tooling of `softistx/nxgt-http`: the
same build, artifact check, publish script, CI and conventions. When one of
them changes there for a reason that applies here, change it here too.

## Layering

Every package is **standalone**: it depends on no sibling, only on the
library it wraps, as a peer — except the bridge, `@nxgt/mongo-meilisearch`,
below. A package that would use a sibling declares it
by `workspace:^` and imports it by its published name, as in nxgt-http; there
is no tsconfig `paths` to a sibling and no relative import into one.

- `@nxgt/drizzle` has `drizzle-orm` as a peer, `>=1.0.0-rc.4 <2`, and as a
  devDependency pinned exactly (`1.0.0-rc.4`): Drizzle 1.0 is a release
  candidate, and its types move between RCs. Raise both together, after
  reading the new `.d.ts`: 1.0 changed the relational queries, the column
  types and some imports from 0.x. `@electric-sql/pglite` is a
  devDependency: the specs run a real PostgreSQL in process, with no Docker.
- `@nxgt/meilisearch` has `meilisearch`, the official SDK, as a peer,
  `>=0.62.0 <1`, and as a devDependency pinned exactly (`0.62.0`): a 0.x
  SDK may break its types in a minor. Raise both together, after reading its
  `indexes.d.ts` and `types/types.d.ts`, where `Settings` and `SearchParams`
  live, and `token.d.ts`: `tenantToken` imports `generateTenantToken` from
  the SDK's `meilisearch/token` subpath, which the peer range must keep.
  The SDK's errors reach the caller as they are — except inside a
  `REBUILD_FAILED`, which carries the one that stopped a rebuild as its
  `cause`; the package's only error of its own is `SearchIndexError`.
- **`@nxgt/mongo/migrations` and `@nxgt/mongo/gridfs` are subpaths** of
  `@nxgt/mongo`, not packages: both reuse its coercion, its `withTransaction`
  and its errors, and version with it. `src/migrations/` and `src/gridfs/`
  import the rest of the package; nothing else imports either.
- **A dialect is a subpath**, not a package: `@nxgt/drizzle/pg` today,
  `./mysql` and `./sqlite` later. What does not depend on a dialect, the
  errors, the cursor and the page shapes, is in `@nxgt/drizzle` itself, and
  every dialect throws those same classes.
- `@nxgt/mongo` has two peers, both required: `mongodb` `>=7.0.0 <8` and
  `zod` `>=4.6.5 <5`, pinned exactly as devDependencies (`7.6.0`, `4.6.5`).
  Zod is not an implementation detail there: the schema an application writes
  is the package's input, so the application's copy has to be the one the
  package parses with. Raise them together, after reading `mongodb.d.ts`,
  where `Filter`, `UpdateFilter` and `IndexDescription` live.
  `mongodb-memory-server-core` is a devDependency, and it depends on
  `mongodb ^7.2.0`: keep the pin inside that range, or the tree carries two
  drivers and two `ObjectId` classes, which no `instanceof` survives.
- **Three kits are built on siblings**, and all three are the same
  shape: a package over siblings is a package of its own, never an import
  from one into another. `@nxgt/mongo-kit` has `@nxgt/mongo` as a required
  peer, by `workspace:^`, and as a devDependency the same way; `mongodb` is a
  peer with the sibling's range and pin. `@nxgt/mongo` knows nothing of it.
  Its buckets come from the `@nxgt/mongo/gridfs` subpath of that same peer,
  so they added no dependency; the build keeps the subpath external like the
  root.
  `@nxgt/redis-kit` is the same over `@nxgt/redis`, and carries `zod` with
  the sibling's range and pin instead of a driver — `@nxgt/redis` has no
  driver peer to carry. `@nxgt/mongo-search-kit` peers on four siblings at
  once and none of them knows it either.
- **Two packages are bridges**, and both are the same shape.
  `@nxgt/mongo-meilisearch` has `@nxgt/mongo` and `@nxgt/meilisearch` as
  required peers, by `workspace:^`, and as devDependencies, the same way;
  `mongodb` and `meilisearch` are peers with their siblings' ranges and pins.
  `@nxgt/drizzle-meilisearch` is the same over `@nxgt/drizzle` and
  `@nxgt/meilisearch`, carrying `drizzle-orm` and `meilisearch`. No sibling
  knows either of them: a bridge between two packages is a third package,
  never an import from one into the other. `bun publish` turns `workspace:^`
  into `^<current version>`, and changesets gives a bridge a **patch** when a
  sibling it peers on takes a minor (measured with changesets 3.0.3), so it
  is republished with the new range.
- **Another database library is another package**, and each keeps its own
  errors, as every package here does.

**There are no cycles and there must not be one**, devDependencies included.

## The build

Every package is built by the root `build.ts`, as `bun run ../../build.ts`:

- **JavaScript**, from `Bun.build` with `packages: 'external'` and
  `splitting: true`. A library never bundles its dependencies: a copy of
  `drizzle-orm` would give an app two `SQL` classes, and an `is()` that fails
  for one. Splitting puts what two entry points share in a chunk both
  import: without it, `@nxgt/drizzle/pg` would throw its own copy of
  `NotFoundError`, which an `instanceof` against the one from
  `@nxgt/drizzle` rejects.
- **Declarations**, from `tsc --emitDeclarationOnly` against
  `tsconfig.build.json`, which excludes `*.spec.ts` and `test/`.

Entry points are declared under `nxgt.entrypoints`, and each one needs a
matching key in `exports`.

- **`export * from '<external package>'` only in an entry point.** Below one,
  Bun emits a re-export of an undeclared variable, and the built file throws
  at import while `bun run build` exits 0.
- **A build that exits 0 is not evidence the artifact loads.**
  `bun run verify:artifacts` packs every package, installs the tarballs as a
  consumer does, imports every subpath in `exports`, runs every bin with
  `--help`, and rejects a manifest that would break an install: a `link:` or
  `file:` in a field a consumer resolves, a **required** peer on no registry,
  a sibling range that leaves out the sibling released beside it, an exact pin
  on a sibling, or a package that is not MIT or ships no `LICENSE`. `changeset:publish` runs it, so a release cannot skip it.
- **Build before typecheck and tests.** CI builds first.

- **`@nxgt/redis` has no client dependency at all.** `RedisClient` is Bun's
  own, which is what makes the package Bun-only and why it declares no driver
  peer — the one place in this repository where the "peers and pins move
  together" rule has nothing to pair. Its `zod` peer `>=4.6.5 <5` and its
  exact `4.6.5` pin move with `@nxgt/mongo`'s: raise them together or the
  workspace holds two zods. Read Bun's `redis.d.ts` before using a command,
  not the Redis manual: the client covers a subset, and has no `multi`/`exec`.

## Tests

- **Specs run against PostgreSQL, not a mock**: PGlite, in memory, one per
  spec file (`test/db.ts`), emptied between tests. The DDL is plain SQL in
  `test/schema.ts`, next to the Drizzle tables, with named constraints the
  specs assert on. No drizzle-kit.
- **`@nxgt/meilisearch`'s specs run against a real Meilisearch**, not a mock
  and not Docker: the official binary, from the GitHub releases of
  meilisearch/meilisearch, pinned in `scripts/meilisearch.ts`
  (`MEILISEARCH_VERSION`, v1.53.2 today). The script downloads it for the
  platform (linux amd64/aarch64, macOS Apple silicon) into the git-ignored
  `.cache/meilisearch/<version>/meilisearch`, and prints its path; the
  package's `test` script runs it first. `$MEILISEARCH_BIN` names another
  binary, for Intel macOS, which v1.53 no longer ships a community build
  for. `test/server.ts` starts one server per spec file, on a free port,
  with a temporary `--db-path` and a master key, waits for `/health`, and
  kills it in `afterAll`; `reset` deletes every index between tests. CI
  caches `.cache/meilisearch`, keyed on the hash of the script, so raising
  the version there re-downloads.
- **`@nxgt/mongo`'s specs run against a real mongod**, started by
  `mongodb-memory-server-core` as a **single-node replica set**: transactions
  need one, and a standalone mongod refuses to start one. The version is
  pinned in `test/server.ts` (`MONGOD_VERSION`, 8.2.6 today), and the binary
  is downloaded on the first start into the git-ignored `.cache/mongodb`,
  which CI caches keyed on the hash of that file. `-core` rather than
  `mongodb-memory-server`: the wrapper's `postinstall` downloads 120 MB during
  every `bun install`. On Arch and Manjaro the library falls back to the
  Ubuntu 22.04 build on its own; keep mongod at 6.0 or above, because the
  older fallback wants `libcrypto.so.1.1`, which a current distribution no
  longer ships.
- **`@nxgt/mongo-meilisearch`'s specs run against both**: its `test/`
  holds a copy of each sibling's server (`mongo.ts`, `meilisearch.ts`), and
  `test/fixtures.ts` starts one of each per spec file. Its specs are
  `create-search-sync` (the options and errors, no server), `reindex`,
  `follow` and `lease` — the last makes a second process by creating a
  second sync under the same name, and steals a lease by rewriting its
  holder. Its `test` script
  downloads Meilisearch first, as `@nxgt/meilisearch`'s does, and passes
  `--timeout 30000`: Meilisearch takes about half a second to apply each
  write, measured, so a test that writes a few batches outlasts Bun's 5 s.
- **`@nxgt/drizzle-meilisearch`'s specs run against both too**: PGlite in
  process (`test/db.ts`, with its own one-table `test/schema.ts`) and the
  fourth copy of the Meilisearch server (`test/meilisearch.ts`), one of each
  per spec file. Its specs are `create-search-sync` (the options and the
  refusals, no server at all — `createSearchSync` does no I/O, so a
  repository and an index that are only their shapes are enough), `reindex`
  and `write`. Same `--timeout 30000`, for the same reason.
- **`@nxgt/mongo-kit`'s specs** hold the third copy of the mongod server
  (`test/server.ts`), one per spec file, and `test/fixtures.ts` closes the
  kits a file opened: `connectMongo` shares a client per URI, so a kit a
  test left open keeps the server alive. `close.spec.ts` is on its own for
  that reason — it measures what closing gives back, which only holds when
  nothing else holds the client. `test/models/` and `test/models-clash/` are
  the files `discoverCollections` globs.
- **`@nxgt/mongo-search-kit`'s specs** hold the fifth mongod copy and a
  second Meilisearch one (`test/mongo.ts`, `test/meilisearch.ts`), and
  `test/fixtures.ts` starts one of each plus **one `MongoKit`** per spec
  file. `beforeEach` drops both databases and then calls `kit.sync()`: the
  drop takes the collections with it, and `autoSync` runs once per
  collection per process, so nothing would recreate them. Its `test` script
  downloads Meilisearch and passes `--timeout 30000`, for the same measured
  reason as the bridge's. Two of its specs are regression specs with no
  assertion of their own shape: one fails by **killing the run** if a
  sync's `closed` stops being taken as it starts, and one pins that
  `close()` still throws a second sync's failure once `failed` is spent.

- **`@nxgt/redis`'s specs run against a real Redis**, one per spec file,
  emptied before each test. There is **nothing to download**: neither
  redis/redis nor valkey publishes a prebuilt binary, so `redis-memory-server`
  fetches the source and **compiles** it. What that costs is measured and
  written down in one place, `packages/redis/test/server.ts`; do not repeat
  the numbers here. That is why `scripts/redis.ts` exists and the package's `test` script runs it first,
  the way `@nxgt/meilisearch`'s runs `scripts/meilisearch.ts`: that build does
  not belong inside a test's timeout. The script holds no logic of its own —
  `redisBinary` lives beside the server that starts it — and
  `scripts/redis.spec.ts` covers its `$REDIS_BIN` branch. `$REDIS_BIN` names a `redis-server` to
  use instead. CI caches `.cache/redis`, keyed on **both** copies of
  `test/server.ts` — `@nxgt/redis`'s and `@nxgt/redis-kit`'s — and the
  script. `test/fixtures.ts` calls `closeRedis()` before stopping the server,
  because `connectRedis` shares a client per URI and a connection a test left
  open would outlive it.

- **`@nxgt/s3`'s specs run against a real S3 API**, one SeaweedFS per spec
  file: `weed server -s3`, from the binary `scripts/seaweedfs.ts` downloads
  into `.cache/seaweedfs`. **Not MinIO** — measured 2026-09-18, `dl.min.io`
  answers `410 Gone` and the project is archived, so nothing in any repository
  should plan around it. Five things about SeaweedFS were measured here and
  every one of them is a line in `test/server.ts`: `-dir` must already exist,
  or it dies; 4.47 starts an **Iceberg** catalog on a fixed 8181 and a
  **Lance** namespace on a fixed 9101, either of which kills the process when
  a second spec file starts, so both are `=0`; each service listens **twice**,
  and its gRPC port defaults to its own `+10000`, so either name it —
  `-master.port.grpc` and the three others, which is what `test/server.ts`
  does — or keep that neighbour free; and each bucket is a *collection*
  needing a volume,
  which the production defaults (8 volumes of 30 GB) cannot allocate — hence
  `-master.volumeSizeLimitMB=64 -volume.max=100`. **Its log goes to a file,
  never a pipe**: SeaweedFS fills a 64 KB pipe buffer in under a minute, and a
  pipe nobody drains blocks the process writing to it. **It is stopped with
  `SIGKILL`**: measured on 4.47, `weed server` takes **20 s** to exit on
  SIGTERM *or* SIGINT — 20078 / 20024 ms and 20015 / 20102 ms over two runs
  each — and **11 ms** on SIGKILL. That is a fixed grace period, not a flush,
  and the directory it writes into is removed on the next line. It was the
  whole of the suite's local slowness: `packages/s3` ran in 24.9 / 29.9 /
  29.5 s and now runs in 5.2 / 4.9 / 4.9 s, and a default 5 s hook timeout
  used to report a phantom `(fail) (unnamed) [5000ms]` that named no test.
  `@nxgt/meilisearch`'s server does **not** share the defect — measured, it
  stops in 8 ms on SIGTERM — so do not copy the signal across. `weed` also
  leaves a unix socket in the temp directory per port it bound, so `stop()`
  removes the eight it knows.

- **Type tests** are `test/types/*.ts`, checked by the package's
  `typecheck` (`tsc --noEmit`) and never run. A call that must not compile
  carries `// @ts-expect-error`; if it compiles, tsc fails on the unused
  directive.

- **A spec that watches a promise reject takes the rejection where the
  promise is made**, not after the line that causes it. In that window
  nobody is waiting, Bun counts the rejection as unhandled, and the test
  fails with the very error it came to assert — a loaded CI runner fails
  where an idle laptop passes, which is exactly how this was found. Hold it
  with a plain `.then(onResolved, onRejected)` whose resolved arm throws
  (`rejection` in `packages/mongo/src/collection/changes/subscription.spec.ts`),
  and assert on `expect(await held)`. **Not** `expect(promise).rejects`:
  measured on bun 1.4.2, holding that assertion across an `await` and
  finishing it later never returns — the whole file runs out of time and the
  per-test timeout does not fire. A fixture that hands back something
  long-lived takes its `closed` at hand-over, the way `track()` does here and
  in `packages/mongo-meilisearch/test/fixtures.ts`.

## Releasing

Changesets, with independent versions. `bun changeset` describes a change.
Merging to `develop` opens a "Version packages" PR, and merging that PR
publishes to npm.

- **A change under `packages/` needs a changeset.** CI runs
  `changeset:status`, except on `changeset-release/develop`. A change that
  reaches a consumer takes one naming the package; a change that cannot —
  a spec, a comment, anything `tsconfig.build.json` excludes and `files`
  does not ship — takes `bun changeset --empty`, which says in words why
  nothing is published. Measured on changesets 3.0.3: the gate is that *some*
  changeset was added on the branch, not that one names the changed package.
- **`bun publish`, not `changeset publish`.** `scripts/publish.ts` publishes in
  dependency order and skips versions already on the registry. It writes the
  `git-tag` events `changesets/action@v2` reads from `$CHANGESETS_OUTPUT`.
- **Registry configuration lives in `bunfig.toml`, never in `.npmrc`.**
  Installing needs no token. Publishing reads `$NPM_TOKEN`, which must be a
  **granular** access token covering the `@nxgt` scope, not selected
  packages. The `NPM_TOKEN` secret holds it for CI; it is an organisation
  secret of `softistx`. The only test of whether a token can publish is a
  publish.
- **The release PR needs the repository's switch.** Settings → Actions →
  General → Workflow permissions: *Read and write*, plus *Allow GitHub Actions
  to create and approve pull requests*. To check it:
  `gh api /repos/softistx/nxgt-data/actions/permissions/workflow`.
- **Siblings are depended on by `workspace:^`, never `workspace:*`.** What
  `workspace:^` becomes in a published manifest is read from **`bun.lock`**,
  not from the sibling's `package.json` — measured: `@nxgt/mongo-meilisearch`
  0.1.0 went out with a peer on `@nxgt/mongo` `^0.10.0` while the workspace
  held 0.11.0, because `changeset version` bumps manifests and leaves the
  lockfile alone. `changeset:version` therefore ends with
  `bun install --lockfile-only`, and a stale `bun.lock` in a release is a bug,
  not noise.
- **`typescript` is a peer, `^6.0.3`, in every package**, as in nxgt-core
  and nxgt-http; do not raise it in one package alone.
- **Every package is public**, like the repository. Never `private: true`.
- **Every package is MIT**, `"license": "MIT"`, with `LICENSE` in its `files`
  and a copy of the root `LICENSE` in its directory. A new package copies it.

## Deliberate duplication: do not "clean this up"

| Kept twice | Why |
| --- | --- |
| `LICENSE`, at the root and in each `packages/*/` | npm ships only the `LICENSE` in the package's own directory. `verify:artifacts` fails a tarball without one. Change them all together |
| `build.ts`, `scripts/`, `.github/`, `biome.json`, `bunfig.toml` | copied from nxgt-http, not shared: each repository releases on its own. Change both when the reason applies to both |
| `pagination/page.ts` and `pagination/cursor.ts`, in `@nxgt/drizzle` and `@nxgt/mongo` | every package is standalone, and a shared `@nxgt/pagination` would make one depend on a sibling for four exported shapes. `page.ts` is the closest of the two — 104 and 109 lines, fifteen of them different — so **a fix in one is a fix to make in the other**. `errors/data-error.ts` looks like a third copy and is not: the classes differ. `@nxgt/s3`'s `ObjectPage` is **not** a copy either — four lines agreeing with `CursorPage`'s shape so a caller pages the same way, with no logic to keep in step |
| `connection/connect.ts`, in `@nxgt/mongo` and `@nxgt/redis` | reference-counted client sharing per URI, copied rather than factored: a shared `@nxgt/connection` would make both depend on a sibling for one function, and layering comes first. **107 of 167 lines are identical**, comments included — closer than `page.ts` — so **a fix in one is a fix to make in the other**, and a spec added to one belongs in the other. What deliberately differs: `@nxgt/redis` has no `db`, holds the `RedisClient` itself rather than a `Promise<MongoClient>`, closes synchronously, closes sequentially in `closeRedis` where `closeMongo` uses `Promise.all`, and compares options with `Bun.deepEquals` in place of a hand-written `sameValue`. Since the error-code work, a sixth: `@nxgt/redis`'s `ping` races the command against a timer of its own and reports `PING_TIMEOUT` on the result, while `@nxgt/mongo`'s leaves the deadline to the driver's `timeoutMS` and reports whatever it produced. Both connection failures are a class with a code now, and **neither carries the URI** — a connection string holds the password, and a spec in each asserts its absence |
| `pingClient` in `@nxgt/redis-kit`, and `ping` in `@nxgt/redis`'s `connection/connect.ts` | a client the *configuration* handed in carries no `ping` — that one belongs to what `connectRedis` returned — so the kit has its own copy, down to the `PING_TIMEOUT` code and the message, and a health route reads the same answer either way. **A fix in one is a fix to make in the other.** The sibling exports no standalone `ping` to call instead; if it ever does, this copy goes |
| `pingDb` in `@nxgt/mongo-kit`'s `kit/ping.ts`, and `ping` in `@nxgt/mongo`'s `connection/connect.ts` | the same reason as the Redis pair: a database the configuration handed a `client` has no `MongoConnection`, so no `ping`, and a health route should read one answer for both. **A fix in one is a fix to make in the other.** The kit calls the copy **only** for a handed-over `client`; a database it opened goes through its `MongoConnection.ping`, the original — as `@nxgt/redis-kit` does. What deliberately differs: the copy races a timer of its own, because — measured on mongodb 7.6.0 — `timeoutMS` does not bound the connect a never-connected client makes on its first command (it waits `serverSelectionTimeoutMS`); a timer with the same deadline on a connected client always fires first and hides the driver's `MongoOperationTimeoutError`, measured 5/5, which is why the original has none. The deadline error is a bare `Error` with no code, unlike Redis's `PING_TIMEOUT`: `ping` reports rather than refuses, and `@nxgt/mongo`'s own reports whatever the driver produced. If `@nxgt/mongo` ever exports a standalone `ping`, this copy goes |
| `test/server.ts` of `@nxgt/redis`, copied into `@nxgt/redis-kit` | the same rule: a package reaches no sibling's tests, and a kit over a sibling is a package like any other. Keep `REDIS_VERSION` equal in both copies — `redis-memory-server` **compiles** the source, so two versions is two builds and two caches, and CI keys the redis cache on the hash of both files and `scripts/redis.ts`. `@nxgt/redis-kit`'s copy adds nothing to the server itself; what differs is its `test/fixtures.ts`, which also closes the kits a spec opened |
| `test/server.ts` of `@nxgt/mongo` and of `@nxgt/meilisearch`, as `test/mongo.ts` and `test/meilisearch.ts` in `@nxgt/mongo-meilisearch` and again in `@nxgt/mongo-search-kit`, as `test/server.ts` in `@nxgt/mongo-kit`, and once more in `examples/hono-api/test/kit.ts` | a package reaches no sibling's tests, and an example reaches no package's. Keep `MONGOD_VERSION` equal in all five mongod copies: CI keys the mongod cache on the hash of those five files |
| `test/server.ts` of `@nxgt/meilisearch`, a **fourth** time as `test/meilisearch.ts` in `@nxgt/drizzle-meilisearch` | the same rule. The Meilisearch cache key hashes `scripts/meilisearch.ts` alone — the script pins the version, and the copies only start the binary it prints — so a new copy needs no CI change |
| `test/db.ts` of `@nxgt/drizzle`, copied into `@nxgt/drizzle-meilisearch` | the PGlite helper: one database per spec file, `reset` between tests. The copy carries this package's own `test/schema.ts` — one `articles` table instead of five — so only the four lines around `createTestDb` are the same |
| `batch.ts`, `documents.ts`, `errors.ts` and `reindex.ts`'s `sendAll`/`removeUnwanted`, in `@nxgt/mongo-meilisearch` and `@nxgt/drizzle-meilisearch` | the two bridges write to Meilisearch the same way: chunking by `batchSize`, one `Entry` per id so adds and deletes cannot race, `keyOf` telling `1` from `'1'`, the same `SearchSyncError`/`failed` pair, and the same read-back of the index 1 000 ids at a time to find what to take out — `LIST_LIMIT`, `missingIndex` and `removeUnwanted` are identical. **A fix in one is a fix to make in the other.** What deliberately differs: `entryOf` takes a row and reads its id through the caller's required `toIndexId` instead of taking a Mongo `_id`; the batch helpers take a `wait` flag, because only `reindexAll` waits here; `reindexAll` takes a per-call `pageSize` where the Mongo one reads `ctx.pageSize`, and an `onPage` progress callback the Mongo one has not (its reindex runs inside `start` as often as from a script), and takes no resume token before the scan and saves no state after it; the Drizzle error has no `HISTORY_LOST`, `RUNNING` or `LEASE_LOST`, since nothing is followed and nothing is leased; and **the dedup by `Entry.key` sits on the other side** — the Mongo bridge's follower buffers into a `Map` before calling `send`, while here the list of rows is the caller's, so `indexRows` keys it itself, last one wins |
| The stamp **policy** — optimistic lock, actor stamps and `upsert`'s rules — in `@nxgt/drizzle`'s `pg/repository/stamp-writes.ts` and `operations/upsert.ts`, after `@nxgt/mongo`'s `collection/stamp-writes.ts`, `documents.ts` and `operations/upsert.ts` | not code — no line is shared, and the two drivers could not share one — but one behaviour kept parallel on purpose, down to the names: `upsert(where, values)` with the `where` written as well as matched, a `version` in `update`'s patch that is checked and never written, `updateMany` and `upsert` refusing one, every update raising it, `OptimisticLockError` with `expectedVersion`/`actualVersion` and a second read to tell a moved row from a missing one, `as(actor)` and the `actor` option, a soft-deleted row an upsert will not write over. **A rule changed in one is a rule to consider in the other.** What deliberately differs is listed once, in `packages/drizzle/docs/guide/stamps.md` ("How this differs from `@nxgt/mongo`"): the stamps are read off the table by column key rather than declared; a stamp or a version a write gives itself is kept rather than refused; `optimisticLock: false` makes `version` an ordinary column rather than refusing an expected one; refusals are `ArgumentError`s; a soft delete and a restore also stamp `updatedAt`/`updatedBy`; PostgreSQL requires the unique constraint an upsert conflicts on; and there are no hooks, so nobody is told which half of an upsert ran |
| `lease.ts` in `@nxgt/mongo-meilisearch`, after `migrations/lock.ts` in `@nxgt/mongo` | a bridge takes no sibling's internals, and the lock is not exported. Both keep one document timed by the server (`$$NOW`), name the holder `host:pid:<ObjectId>`, renew with an update filtered on the holder, and release with a `deleteOne` on it. **What deliberately differs is the taking**: the lease is one `findOneAndUpdate` with `upsert` whose pipeline update keeps a live holder's fields and writes its own when the lease lapsed — no `$documents`/`$merge` `aggregate`, which a failpoint on the change stream's `aggregate` also caught; and a lease found lost stops the running sync, or the reindex before it removes or records, with `LEASE_LOST`, where the lock only fails the migration run. A fix to renewal or release in one is a fix to consider in the other |

## Keeping the code maintainable

These are measured limits, not taste. They exist because both packages grew
the same shape before anyone looked: `@nxgt/mongo`'s `build()` reached **487
lines** and `@nxgt/drizzle`'s **353**, and both have since been taken apart
the same way — the drizzle one down to **31**. The drizzle number said 321 for
longer than it was true, which is its own lesson: measure it when you touch
the file.

- **A long file of declarations is fine; a long function is not.** A type or
  an options interface earns its length in documentation —
  `mongo/src/collection/types.ts` is 513 lines and every one of them is a
  declaration with a reason. A *function* past **80 lines** is the signal.
  Keep a source file under **250** lines; when it climbs, it is almost always
  one function that grew, not a file that filled up.
- **A builder that grows becomes a context plus modules by role.** When a
  factory accumulates a closure — ten captured variables and twenty inner
  functions — extract the resolved state into a `context.ts`, and move the
  methods into modules named after what they do: `filters.ts`,
  `documents.ts`, `operations/reads.ts`, `operations/writes.ts`,
  `operations/paginate.ts`. Each takes the context as its **first
  argument**. `mongo/src/collection/` is the worked example, and the factory
  that is left (`get-collection.ts`) only assembles and proxies.
  `@nxgt/drizzle`'s `pg/repository/` is the second one, done the same way and
  on purpose in a PR of its own: `create-repository.ts` fell from **419 lines
  to 103** and its `build()` from **353 to 31**, against an unchanged 113
  tests. A split like this is never made in the same PR as a behaviour
  change — the identical test count is the only evidence that nothing moved,
  and it is worthless if the tests changed too.
- **The context holds data, not closures.** This is the half of the rule that
  is easy to miss, and it was missed here first: a `createContext` that
  resolves the options *and* returns eight functions closed over them is the
  same factory one size down, and it grew straight back to 173 lines. Once
  `hasOwnId` and `parses` were on the context like every other resolved
  value, every helper became a plain function over it and the factory fell to
  **41 lines**. If a context field cannot be printed, it does not belong on
  the context. The one exception is the caller's own hooks,
  which are handed over as given: the rule is about closures the package
  builds.
- **A folder is a subject; when one holds more than one, split it.** A
  folder past a dozen source files, or one whose files need a prefix to tell
  them apart (`hook-types`, `change-types`), is several subjects. In
  `mongo/src/collection/` the root keeps what every subject shares — the
  surface (`get-collection.ts`, `types.ts`, `auto-sync.ts`), the
  `context.ts`, `filters.ts`, `documents.ts`, the reading of the strings a
  caller passes, `coerce.ts`, and the stamp-write policy `documents.ts`
  applies, `stamp-writes.ts` — and each subject has a folder whose files drop the prefix:
  - `operations/` — `reads`, `writes`, `upsert`, `paginate`;
  - `hooks/` — `types`, `sets`, `hooked`;
  - `changes/` — `types`, `events`, `subscription`, `retry`;
  - `aggregation/` — `types`, `distinct`, `group-by`, `populate`.

  A subject imports the root, and another subject only one way: `hooks/`
  wraps `operations/writes`, so `operations/` never imports `hooks/`. Only
  `get-collection.ts` and `types.ts` reach into all of them. The one root
  import of a subject is `context.ts` → `hooks/sets`, a leaf that imports
  nothing and turns the `hooks` option into context data.
- **Specs are split by subject, not one per source file.** `@nxgt/drizzle`'s
  `pg/repository/` has seven — `create-repository` for what the factory
  decides, `operations/reads`, `operations/writes`, `operations/upsert`,
  `soft-delete`, `optimistic-lock` and `actors` — and a spec file is not
  free: it opens a database of its own. Measured, `createTestDb` costs
  0.8-2.0 s cold and far less warm, so two more files cost **+0.5 s**; the
  three the parity with `@nxgt/mongo` added, with their 33 tests (and one
  more in `columns.spec`), took the suite from **9.1-10.1 s** to
  **11.9-13.3 s** over five runs; `@nxgt/s3` was left whole because the same measurement
  came back at **+13 s** on a 5 s suite, one SeaweedFS per file — before
  `stop()` took SeaweedFS down with `SIGKILL`. Its second server file,
  `operations/presign-post.spec.ts`, measured the cost again: the suite went
  from **9.1 s** to **10.5-15.4 s** over five runs, 2.1 s of it the expiry
  spec's own wait, against a file that would have taken `bind-bucket.spec.ts`
  past 850 lines. Measure before splitting, and say the number. `collection/` has
  fourteen, beside the code they test: `id`, `coerce`, `upsert`,
  `optimistic-lock`, `soft-delete`, `stamp-writes`, `driver-methods`,
  `auto-sync` and the general one at the root,
  `operations/paginate`, `hooks/hooks`, `changes/changes`,
  `changes/subscription` and `aggregation/aggregation`. Beside `collection/`,
  `connection/connect` covers `connectMongo`, `migrations/` has three:
  `plan` (the list against the records, no server), `migrate` and `lock`, and
  `gridfs/` has three: `define-bucket` and `serve` (no server) and `gridfs`
  (everything against one). A refactor that moves code must leave them untouched —
  if a spec has to change, the refactor changed behaviour.
- **A deduplicating write elects on the server, never on a rule each caller
  works out for itself.** `putOnce` in `@nxgt/mongo/gridfs` is the worked
  example, and the reason is measured: the copies collide on the unique
  `{ files_id, n }` index and then on `_id`, because the bytes decide the id.
  An order every caller computes the same way — `(uploadDate, _id)` — cannot
  do it, whatever the key: a document is not visible when it is written but
  when it is committed, so the copy that is first by any client-side key can
  be the last one anybody can see, and every caller then finds itself first.
  That was a released defect, not a theory. It follows that `putOnce` creates
  the bucket's indexes itself whatever `autoSync` says, that `drop()` forgets
  the memo of having created them, and that **no call removes a `files`
  document it did not write** — a caller takes back only the chunks whose
  `_id` it wrote.
- **A public method that refuses something must have a `@ts-expect-error`
  case** in `test/types/`. Type safety is what the compiler rejects, not what
  the README claims: when this was last measured on `@nxgt/mongo`, **seven of
  twelve** plausible mistakes still compiled.
- **Never factor across packages.** Layering comes first; a near-copy goes in
  the duplication table above instead, with what makes the two diverge.
- **Refactoring is its own pull request**, with a `chore:` commit and a patch
  changeset that says plainly that nothing public moved. The proof is that
  the test counts are identical on both sides of it.
- **The `code-reviewer` agent** checks all of this. It comes from the shared
  `nxgt-review` plugin (marketplace `nxgt-core`), and reviews against this
  file and its reference for this repository,
  `plugins/nxgt-review/references/nxgt-data.md` in `softistx/nxgt-core`. It
  reads and reports; it does not edit. Run it before opening a pull request
  (skill `review-before-a-pr`), and `documentation-auditor` (plugin
  `nxgt-docs`) beside it when a public surface changed. A rule changed here
  is changed in that reference too.

## Conventions

- Biome, with tabs and single quotes. Run `./node_modules/.bin/biome check
  --write` before committing, and `biome ci` must pass.
- Commit messages: `<type>: <Capitalized summary>`, with types `feat`, `fix`,
  `update`, `chore`, `docs` and `typo`.
- Git: the default branch is `develop`. Work on a feature branch and open a
  pull request into `develop`.
- A repository script is a TypeScript file run by Bun, with Bun Shell, not a
  `.sh`.
- **Imports carry no extension**: `from './repository'`, not
  `'./repository.js'`. Every tsconfig here resolves as a bundler does, and
  Bun runs the specs the same way. The READMEs' examples carry none.
- **A package's `README.md` is its page on npmjs.** It is read by someone who
  has never seen this repository: organize it by section, with a copy-paste
  example each, an **API** section and a **Traps** section, and never name a
  private application.
- Specs live next to the code they test (`*.spec.ts`), and files are
  organised in folders by role (`errors/`, `pagination/`, `pg/repository/`…),
  not flat.
- **A package keeps its own errors.** `@nxgt/drizzle` throws `DataError` and
  its subclasses; it depends on no exception package.
- **Which base class, and whether a refusal gets a code.** Two questions, and
  they are answered separately.
  - *A code, or a bare `TypeError`?* A refusal at **definition or wiring
    time** — `defineCache('')`, `defineBucket({})`, a table with no primary
    key, `connectRedis` called twice with different options — stays a bare
    `TypeError`: it cannot come from a request, and no handler should answer
    it. A refusal at **call time, on a value that could have come from a
    request** — a `where`, an `orderBy`, an `acl`, an `expiresIn` — carries a
    class with a `code`, so a handler answers 400 without matching message
    text.
    `@nxgt/mongo-kit` is the deliberate exception: every one of its refusals
    is wiring-time, and it still gives them codes, because it has seven
    distinct ones and a start-up script wants to tell them apart. The rule
    underneath is **a handful of refusals can be told apart by their
    sentence; a dozen cannot**.
  - *Extend `Error` or `TypeError`?* Extend whichever class the refusals it
    replaces already threw, so no consumer's `catch` stops working.
    `KitError` and `ArgumentError` replaced bare `TypeError`s, so they extend
    `TypeError`; `DataError`, `RedisError` and `S3Error` never replaced one,
    so they extend `Error`. A class that extends `TypeError` must be tested
    for **before** any `TypeError` branch in a handler, and its docs say so.
  - `@nxgt/mongo` has **no** `ArgumentError`: a refused argument there is a
    bare `TypeError`, and `packages/mongo/docs/guide/errors.md` says so
    outright, because an application on both it and `@nxgt/drizzle` gets a
    code for one and message text for the other.
- **A message names what failed, not only what was wrong.** Every one of these
  packages has several calls that take options under the same names — `page`,
  `pageSize`, `limit`, `after` — so `limit must be an integer of at least 1`
  is true and useless: a log line holding it says which of an application's
  listings produced it never. A refusal names the call and the thing it was
  on, and it names the call **a consumer wrote**, not the function behind
  it: `paginate on "uploads": limit must be…` for a bucket's listing, whose
  internal function is `paginateFiles`,
  `Invalid cursor in paginateByCursor on "posts": …`,
  `Chunk 4 of file 6721… in "uploads" holds a string where its bytes should
  be`. Where a message is what a consumer searches for, the searchable lead
  stays in front and the call is named after it. A helper that several calls
  share takes an optional trailing `where` rather than being copied per call.
- **A message reports a shape, never a value.** A transform's return, a
  chunk's `data`, an option off a request body: say `a string`, `an array`,
  `no data field`. The value came from somewhere this package does not
  control and can hold anything the documents held.
- **`process.emitWarning` is the one warning channel.** Nothing here logs on
  its own account. The one `console.error` in the estate is `@nxgt/redis`'s
  default `onError`, which is a callback the caller replaces — a message that
  would otherwise end the process, not a package deciding to write. A
  package that has something to say and nothing to refuse — a GridFS bucket
  whose missing index makes every read a collection scan — emits one
  `process` warning with a `code` of its own (`NxgtGridFSMissingIndex`), once
  per subject for the life of the process. It is the one channel every
  application already has, it can be listened to with `process.on('warning')`
  or silenced, and it commits nobody to a logger. Measured on bun 1.4.2: a
  listener receives it *and* Bun prints it, unlike Node, where a listener
  replaces the default print. A warning never throws and never delays the
  call it is about: probe beside the work, not in front of it, and forget a
  probe that failed so the next call tries again. The memo is a module-level
  `Set` keyed by the subject's own name — `<database>:<bucket>` — and it has
  no reset: a suite that wants to observe the warning binds a bucket of its
  own rather than clearing the memo, because a reset exported for the tests
  is a reset an application can call, and the promise is once per process.
- **The verb says what the function does.** `define*` describes and touches
  nothing (`defineCollection`, `defineIndex`, `defineConfig`,
  `defineMigration`); `get*` and `bind*` attach to a live client without
  reaching the server (`getCollection`, `bindIndex`); `connect*` opens it
  (`connectMongo`). `create*` assembles an object and does **no** I/O:
  `createRepository`, `createSearchSync` and `createContext` are all
  synchronous. **`createKit` is the one exception** — it is `async` and opens
  the clients. Steve kept the name on 2026-09-17, against `openMongo` and
  `connectMongoKit`, because it is the short form of the `MongoKit` it
  returns in a package called `mongo-kit`. Do not read it as licence for a
  second async `create*`.

## Known state

`bun run test` is **1228 pass, 0 fail**: drizzle 147, meilisearch 81,
mongo 532, drizzle-meilisearch 42, mongo-meilisearch 55, mongo-kit 100,
mongo-search-kit 17, redis 46, redis-kit 55, s3 104, hono-api-example 31,
scripts 18. It runs one process
per package, then the scripts' specs. Treat any failure as yours.

- **The test mongod runs with `enableTestCommands`**, so a spec can make it
  fail a command on demand with `t.failNext(['getMore', 'aggregate'], …)`.
  That is how the change-stream specs reach the reopen path, and the error
  code matters — all measured:
  - **43** (CursorNotFound) is the transient one to use. The driver resumes
    once by itself after a failed `getMore`, so fail its `aggregate` too.
  - **91** makes the driver forget the server: every command after it waits
    about ten seconds.
  - **2, 9, 14, 40647** are the caller's own input and are not retried, so
    they cannot stand for a transient failure.
  - `t.clearFailures()` turns a failpoint off; setting `times: 0` still fails
    one more command. The subscription spec calls it after each test.
- **The packages' suites run in parallel, and each wants a server**: a mongod,
  a Meilisearch binary and PGlite, all at once. On a machine that is short of
  memory they fail together, and the failures do not look like what they are: a
  mongo `beforeAll` that times out is reported as `(fail) (unnamed)` and raises
  the test count by one, and Meilisearch fails its first test after several
  seconds and the rest in a millisecond each. Before reading that as a
  regression, run the packages one at a time — green in series means it was the
  machine, not the code.

- **The migration lock is timed by the server (`$$NOW`)**, and two things
  mongod 8.2 refuses shaped how it is taken — both measured:
  - `$expr` in the filter of an **upsert** ("not allowed in the query
    predicate for an upsert"), so taking the lock is two atomic writes: an
    insert, then a take-over of a lapsed lock by an update filtered on
    `$expr`;
  - `$documents` on a **collection's** `aggregate` (it needs
    `{ aggregate: 1 }`), so the insert is `db.aggregate([{ $documents }, { $merge,
    whenMatched: 'fail' }])`, which answers 11000 when the lock exists.
  - `@nxgt/mongo-meilisearch`'s lease on a sync name gets round the first
    one differently: its upsert filters on `_id` alone and puts the decision
    in a **pipeline update** (`$cond` on `$expiresAt <= $$NOW`), which the
    server accepts; two racing inserts answer 11000 to the loser.

- **Meilisearch answers `succeeded` to a settings update whatever it holds**:
  measured on v1.53.2 with an unknown ranking rule, an empty dictionary entry
  and a 600-character sortable attribute. A failed settings task therefore
  cannot be produced against a real server, so `syncIndex`'s `TASK_FAILED` and
  `index_already_exists` branches are covered by a scripted client in
  `sync-index.spec.ts`. Everything a server does reach is tested against the
  real one.
