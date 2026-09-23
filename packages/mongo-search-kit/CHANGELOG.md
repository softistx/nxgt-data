# @nxgt/mongo-search-kit

## 0.2.0

### Minor Changes

- [#88](https://github.com/softistx/nxgt-data/pull/88) [`f239d6a`](https://github.com/softistx/nxgt-data/commit/f239d6ad21fd6256e733f4326b4b78ed6d981bd2) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `search.syncIndexes(options?)` brings every index the search kit wires in line with its definition — created with its primary key when missing, only the settings that differ updated — one after another, and reports `@nxgt/meilisearch`'s `SyncReport` under each key. `dryRun` and `wait` pass through; the first index that throws stops the rest. A deployment is now `kit.sync()` and `search.syncIndexes()`, rather than one `syncIndex` per index.

### Patch Changes

- [#91](https://github.com/softistx/nxgt-data/pull/91) [`e780c55`](https://github.com/softistx/nxgt-data/commit/e780c55369210697254b47043b92fc4efec25af4) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Docs: each entry's sync now takes a lease on its name (from `@nxgt/mongo-meilisearch` 0.3.0), so a second process is refused with `RUNNING` and `leaseMs` is an entry option; `LEASE_LOST` can reject `failed`. The "no lock today" trap is gone.
- Updated dependencies [[`c4069fc`](https://github.com/softistx/nxgt-data/commit/c4069fcdddc6efb3e74ec352f42c094a7d285fb1), [`01063a5`](https://github.com/softistx/nxgt-data/commit/01063a51728a7ff1b0a24281842d2e7d8bd1ea2c), [`e780c55`](https://github.com/softistx/nxgt-data/commit/e780c55369210697254b47043b92fc4efec25af4)]:
  - @nxgt/meilisearch@0.3.0
  - @nxgt/mongo-kit@0.3.0
  - @nxgt/mongo-meilisearch@0.3.0

## 0.1.7

### Patch Changes

- Updated dependencies [[`1f99fcb`](https://github.com/softistx/nxgt-data/commit/1f99fcb8bbf37e6af9cc19a0b919c9c7d6a9a893), [`1f99fcb`](https://github.com/softistx/nxgt-data/commit/1f99fcb8bbf37e6af9cc19a0b919c9c7d6a9a893), [`1f99fcb`](https://github.com/softistx/nxgt-data/commit/1f99fcb8bbf37e6af9cc19a0b919c9c7d6a9a893), [`1f99fcb`](https://github.com/softistx/nxgt-data/commit/1f99fcb8bbf37e6af9cc19a0b919c9c7d6a9a893)]:
  - @nxgt/meilisearch@0.2.0
  - @nxgt/mongo@0.17.0
  - @nxgt/mongo-meilisearch@0.2.0
  - @nxgt/mongo-kit@0.2.1

## 0.1.6

### Patch Changes

- Updated dependencies [[`2e63c80`](https://github.com/softistx/nxgt-data/commit/2e63c80a3530fb5cc600c2deb2ddc1d1b68bfd19), [`2e63c80`](https://github.com/softistx/nxgt-data/commit/2e63c80a3530fb5cc600c2deb2ddc1d1b68bfd19)]:
  - @nxgt/mongo-kit@0.2.0
  - @nxgt/mongo@0.16.0
  - @nxgt/mongo-meilisearch@0.1.8

## 0.1.5

### Patch Changes

- [#66](https://github.com/softistx/nxgt-data/pull/66) [`5c5aa1d`](https://github.com/softistx/nxgt-data/commit/5c5aa1d8b8902c25e9a6a8a12b1ce44834c943f6) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Every package now ships a `docs/` folder, linked from its npm page.
  
  The README stays the short version: what the package is, how to install it,
  and one copy-paste example per area. `docs/` is the long one — a guide page
  per area with the option tables, the defaults, what is returned and what is
  thrown; a `troubleshooting.md` whose headings are the exact error text you
  would paste into a search box, with the line that prevents each one; and a
  `roadmap.md` saying what is coming, and what is deliberately not.
  
  `docs` is named in each package's `files`, so it travels in the tarball
  rather than living only on GitHub.
- Updated dependencies [[`5c5aa1d`](https://github.com/softistx/nxgt-data/commit/5c5aa1d8b8902c25e9a6a8a12b1ce44834c943f6)]:
  - @nxgt/meilisearch@0.1.1
  - @nxgt/mongo@0.15.1
  - @nxgt/mongo-kit@0.1.5
  - @nxgt/mongo-meilisearch@0.1.7

## 0.1.4

### Patch Changes

- Updated dependencies [[`b4f07aa`](https://github.com/softistx/nxgt-data/commit/b4f07aa4c497bec08297a0c4bd9cb0ea57ccc682)]:
  - @nxgt/mongo@0.15.0
  - @nxgt/mongo-kit@0.1.4
  - @nxgt/mongo-meilisearch@0.1.6

## 0.1.3

### Patch Changes

- Updated dependencies [[`a6cac9b`](https://github.com/softistx/nxgt-data/commit/a6cac9bf5f22c44c9b6e1b211ae8946e4658cad3)]:
  - @nxgt/mongo@0.14.0
  - @nxgt/mongo-kit@0.1.3
  - @nxgt/mongo-meilisearch@0.1.5

## 0.1.2

### Patch Changes

- Updated dependencies [[`9117fff`](https://github.com/softistx/nxgt-data/commit/9117fffc1897452d1503c814fc878dbd8082286e)]:
  - @nxgt/mongo@0.13.0
  - @nxgt/mongo-kit@0.1.2
  - @nxgt/mongo-meilisearch@0.1.4

## 0.1.1

### Patch Changes

- Updated dependencies [[`5012472`](https://github.com/softistx/nxgt-data/commit/5012472fdcbb374961b2d604303c9f732da69114)]:
  - @nxgt/mongo@0.12.0
  - @nxgt/mongo-kit@0.1.1
  - @nxgt/mongo-meilisearch@0.1.2

## 0.1.0

### Minor Changes

- [#43](https://github.com/softistx/nxgt-data/pull/43) [`5d672ec`](https://github.com/softistx/nxgt-data/commit/5d672ec0998956f573c21603a98fd2a97de15645) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A search kit over `@nxgt/mongo-kit`: `createSearchKit(kit, config)` takes one
  entry per collection — an index and a transform, under the key the kit wires
  that collection under — and gives one `reindexAll`, one `start` and one
  `close` for all of them. Each entry's sync is `@nxgt/mongo-meilisearch`'s,
  unchanged.
