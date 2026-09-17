# AGENTS.md

Instructions for any coding agent working in `nxgt-data`.

## What this repository is

The `@nxgt/*` packages for data access, published to the public npm
registry:

| package | what it is |
| --- | --- |
| `@nxgt/drizzle` | an SDK over Drizzle ORM: typed repositories (`createRepository`), offset and cursor pagination, `withTransaction`, its own errors with `toDataError`, and the `id()`, `timestamps()`, `softDelete()` columns. PostgreSQL first |
| `@nxgt/meilisearch` | a typed Meilisearch index on the official SDK: `defineIndex<Doc>()({ uid, primaryKey, settings })`, `syncIndex`/`syncIndexes` applying the settings idempotently, and `bindIndex` for typed documents and searches. Its one error is `SearchIndexError` |
| `@nxgt/mongo` | a typed MongoDB collection from one Zod schema: `defineCollection` with its stamps and MongoDB's own collection options, `syncCollection`/`syncAll` applying the `$jsonSchema` validator, the collection options and the indexes idempotently, `getCollection` returning the driver's own `Collection` merged with pagination, soft delete, optimistic locking and audit stamps, `withTransaction`, and migrations in code under the `./migrations` subpath. Its errors are `DataError` and its subclasses |

It was started on 2026-09-15, on the tooling of `softistx/nxgt-http`: the
same build, artifact check, publish script, CI and conventions. When one of
them changes there for a reason that applies here, change it here too.

## Layering

Every package is **standalone**: it depends on no sibling, only on the
library it wraps, as a peer. A package that would use a sibling declares it
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
  live. The SDK's errors reach the caller as they are; the package's only
  error of its own is `SearchIndexError`.
- **`@nxgt/mongo/migrations` is a subpath** of `@nxgt/mongo`, not a package:
  migrations reuse its `withTransaction` and its errors, and version with it.
  `src/migrations/` imports the rest of the package; nothing else imports it.
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
  an exact pin on a sibling, or a package that is not MIT or ships no
  `LICENSE`. `changeset:publish` runs it, so a release cannot skip it.
- **Build before typecheck and tests.** CI builds first.

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
- **Type tests** are `test/types/*.ts`, checked by the package's
  `typecheck` (`tsc --noEmit`) and never run. A call that must not compile
  carries `// @ts-expect-error`; if it compiles, tsc fails on the unused
  directive.

## Releasing

Changesets, with independent versions. `bun changeset` describes a change.
Merging to `develop` opens a "Version packages" PR, and merging that PR
publishes to npm.

- **A change under `packages/` needs a changeset.** CI runs
  `changeset:status`, except on `changeset-release/develop`.
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
- **Siblings are depended on by `workspace:^`, never `workspace:*`.**
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
| `pagination/page.ts` and `pagination/cursor.ts`, in `@nxgt/drizzle` and `@nxgt/mongo` | every package is standalone, and a shared `@nxgt/pagination` would make one depend on a sibling for four exported shapes. `page.ts` is the closest of the two — 87 lines each, ten of them different — so **a fix in one is a fix to make in the other**. `errors/data-error.ts` looks like a third copy and is not: the classes differ |

## Keeping the code maintainable

These are measured limits, not taste. They exist because both packages grew
the same shape before anyone looked: `@nxgt/mongo`'s `build()` reached **487
lines**, and `@nxgt/drizzle`'s still holds **321**.

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
  that is left (`get-collection.ts`) only assembles and proxies. Do the same
  in `@nxgt/drizzle`'s `pg/repository/` when it is next opened for a real
  change — not before, and never in the same PR as a behaviour change.
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
  `context.ts`, `filters.ts`, `documents.ts` and the stamp-write policy
  `documents.ts` applies, `stamp-writes.ts` — and each subject has a folder whose files drop the prefix:
  - `operations/` — `reads`, `writes`, `paginate`;
  - `hooks/` — `types`, `sets`, `hooked`;
  - `changes/` — `types`, `events`, `subscription`, `retry`;
  - `aggregation/` — `types`, `distinct`, `group-by`, `populate`.

  A subject imports the root, and another subject only one way: `hooks/`
  wraps `operations/writes`, so `operations/` never imports `hooks/`. Only
  `get-collection.ts` and `types.ts` reach into all of them. The one root
  import of a subject is `context.ts` → `hooks/sets`, a leaf that imports
  nothing and turns the `hooks` option into context data.
- **Specs are split by subject, not one per source file.** `collection/` has
  twelve, beside the code they test: `id`, `optimistic-lock`, `soft-delete`,
  `stamp-writes`, `driver-methods`, `auto-sync` and the general one at the
  root,
  `operations/paginate`, `hooks/hooks`, `changes/changes`,
  `changes/subscription` and `aggregation/aggregation`. Beside `collection/`,
  `connection/connect` covers `connectMongo`, and `migrations/` has three:
  `plan` (the list against the records, no server), `migrate` and `lock`. A refactor that moves code must leave them untouched —
  if a spec has to change, the refactor changed behaviour.
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

## Known state

`bun run test` is **506 pass, 0 fail**: drizzle 93, meilisearch 42, mongo 361,
scripts 10. It runs one
process per package, then the scripts' specs. Treat any failure as yours.

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

- **Meilisearch answers `succeeded` to a settings update whatever it holds**:
  measured on v1.53.2 with an unknown ranking rule, an empty dictionary entry
  and a 600-character sortable attribute. A failed settings task therefore
  cannot be produced against a real server, so `syncIndex`'s `TASK_FAILED` and
  `index_already_exists` branches are covered by a scripted client in
  `sync-index.spec.ts`. Everything a server does reach is tested against the
  real one.
