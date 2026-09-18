# @nxgt/mongo-search-kit

## 0.1.0

### Minor Changes

- [#43](https://github.com/softistx/nxgt-data/pull/43) [`5d672ec`](https://github.com/softistx/nxgt-data/commit/5d672ec0998956f573c21603a98fd2a97de15645) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A search kit over `@nxgt/mongo-kit`: `createSearchKit(kit, config)` takes one
  entry per collection — an index and a transform, under the key the kit wires
  that collection under — and gives one `reindexAll`, one `start` and one
  `close` for all of them. Each entry's sync is `@nxgt/mongo-meilisearch`'s,
  unchanged.
