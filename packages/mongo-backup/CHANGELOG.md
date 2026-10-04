# @nxgt/mongo-backup

## 0.2.1

### Patch Changes

- [#164](https://github.com/softistx/nxgt-data/pull/164) [`f0ea6a0`](https://github.com/softistx/nxgt-data/commit/f0ea6a01446c4a2a436ee0f81e4a2fe76d0fc36d) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Docs: a new guide, "Running it in production". It covers where each key lives, a scheduled job (a full backup weekly, incrementals in between, a full one on `HISTORY_LOST`, verify, rotation), the oplog and snapshot windows, alerting, restore drills, and what to run the day you need a backup back. It ships with the runnable example `examples/mongo-backup-job`.

## 0.2.0

### Minor Changes

- [#161](https://github.com/softistx/nxgt-data/pull/161) [`5a3f65b`](https://github.com/softistx/nxgt-data/commit/5a3f65b94439977a7c760b85ef4b186ce3c09e1d) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `restoreCollections`: restore part of a backup, chain included. It restores some collections and views, under other names (`as`), whole or only the documents a filter takes (by `_id` or any query), merged into what is there with `existing: 'replace' | 'keep'`. The backup is rebuilt in a scratch database first, and that database is dropped afterwards. New error code `NOT_FOUND`.

### Patch Changes

- [#163](https://github.com/softistx/nxgt-data/pull/163) [`1c587cf`](https://github.com/softistx/nxgt-data/commit/1c587cf8d6d8091abc4fc0b675101683110f9da3) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `mongoTarget({ replace: true })` now replaces a view standing where the backup holds a collection. The server renames over a collection but never over a view, so the restore used to reject with `EXISTS` and tell the caller to pass the `replace: true` they had already passed.

## 0.1.0

### Minor Changes

- [#158](https://github.com/softistx/nxgt-data/pull/158) [`af141a3`](https://github.com/softistx/nxgt-data/commit/af141a3f067efdbf1f222e8227b6a9f2b44c5d66) Thanks [@SteveGT96](https://github.com/SteveGT96)! - First release: MongoDB as a source and a target for `@nxgt/backup`.
  
  - `mongoSource({ db, collections })` reads a full backup in one snapshot session, so every collection is read at one cluster time. Collections, options and indexes are read before and after the snapshot is pinned and must agree, so the metadata is the snapshot's too (`CHANGING` if they never settle). Each collection becomes `metadata/<name>` (its options and indexes) and `documents/<name>` (concatenated BSON, as `mongodump` writes it, number kinds kept). Views keep their pipeline, and GridFS buckets are collections like any other.
  - An incremental or differential backup reads the change stream from where the backup it builds on stopped, into one `changes/<n>` entry: document writes, updates, deletes, collections created, modified, renamed or dropped, and indexes created or dropped. A chain follows the collections of its full backup and those created since; a change to `collections` takes effect at the next full backup.
  - `mongoTarget({ db, replace, tmpDir })` restores into the same database or another one. Each collection lands whole or not at all: it is built under a staging name and renamed into place once its entry has been checked to its end. A collection already there is refused with `EXISTS` unless `replace` is set. Changes are staged to a file and applied only once their entry has been checked.
  - Errors are `MongoBackupError` with a `code` (`SNAPSHOT_TOO_OLD`, `CHANGING`, `HISTORY_LOST`, `UNSUPPORTED`, `EXISTS`, `MALFORMED`), and their messages never quote a document, a name or a value.

### Patch Changes

- Updated dependencies [[`af141a3`](https://github.com/softistx/nxgt-data/commit/af141a3f067efdbf1f222e8227b6a9f2b44c5d66), [`33d6306`](https://github.com/softistx/nxgt-data/commit/33d63062dc350f3d724aca127e52c5c75f53280d)]:
  - @nxgt/backup@0.6.1
