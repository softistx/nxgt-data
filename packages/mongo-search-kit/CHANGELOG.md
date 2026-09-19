# @nxgt/mongo-search-kit

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
