---
"@nxgt/mongo-backup": minor
---

First release: MongoDB as a source and a target for `@nxgt/backup`.

- `mongoSource({ db, collections })` reads a full backup in one snapshot session, so every collection is read at one cluster time. Collections, options and indexes are read before and after the snapshot is pinned and must agree, so the metadata is the snapshot's too (`CHANGING` if they never settle). Each collection becomes `metadata/<name>` (its options and indexes) and `documents/<name>` (concatenated BSON, as `mongodump` writes it, number kinds kept). Views keep their pipeline, and GridFS buckets are collections like any other.
- An incremental or differential backup reads the change stream from where the backup it builds on stopped, into one `changes/<n>` entry: document writes, updates, deletes, collections created, modified, renamed or dropped, and indexes created or dropped. A chain follows the collections of its full backup and those created since; a change to `collections` takes effect at the next full backup.
- `mongoTarget({ db, replace, tmpDir })` restores into the same database or another one. Each collection lands whole or not at all: it is built under a staging name and renamed into place once its entry has been checked to its end. A collection already there is refused with `EXISTS` unless `replace` is set. Changes are staged to a file and applied only once their entry has been checked.
- Errors are `MongoBackupError` with a `code` (`SNAPSHOT_TOO_OLD`, `CHANGING`, `HISTORY_LOST`, `UNSUPPORTED`, `EXISTS`, `MALFORMED`), and their messages never quote a document, a name or a value.
