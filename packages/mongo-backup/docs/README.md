# `@nxgt/mongo-backup` documentation

MongoDB as a source and a target for `@nxgt/backup`: a full backup read in
one snapshot at one cluster time, incremental and differential backups read
from the change stream, and a restore that lands each collection whole or
not at all, into the database backed up or another one. It runs on Bun,
against a replica set (a sharded cluster is untested). Its peers are `@nxgt/backup`,
`mongodb` 7 and `typescript`.

| Page | Read it when |
| --- | --- |
| [Getting started](guide/getting-started.md) | you want a first full backup and a first restore: `mongoSource` and its options, choosing collections with a list or a test, what a snapshot guarantees, how its collections and indexes are read around it, and the window it must fit in, views and GridFS, and a nightly job |
| [Incremental](guide/incremental.md) | you want to store only what changed: what the change stream records, updates and post-images, dotted field names, the collections a chain follows and when a change to `collections` takes effect, renames into and out of them, a dropped database, where the next backup resumes, the oplog window and `HISTORY_LOST`, and a weekly schedule |
| [Restore](guide/restore.md) | you are bringing a database back: `mongoTarget` and its options, the order entries land in, staging under `nxgt-restore-<uuid>`, `EXISTS` and `replace`, how changes are staged and applied, renames and `EXISTS`, one target per restore, restoring one collection with `only`, restoring into another database, what a failure leaves, and restoring into the database you back up |
| [Format](guide/format.md) | you want to know what a backup holds: `metadata/<name>`, `documents/<name>` and `changes/<n>`, their bytes, the recorded position and how it says which collections a chain follows, the fingerprints, and reading a backup with `bsondump` without this package |
| [Errors](guide/errors.md) | you are handling a failure: `MongoBackupError`, its six codes and every message, the driver errors that pass through, the bare `TypeError`s, and a handler for a scheduled job |
| [Troubleshooting](troubleshooting.md) | a call threw and you have the message |
| [Roadmap](roadmap.md) | you want to know what is coming, and what has been ruled out |

The [README](../README.md) is the short version: install, one example for
each operation, the API, the errors and the traps. Repositories, keys,
signing, rotation and the chain rules are `@nxgt/backup`'s —
[its documentation](https://github.com/softistx/nxgt-data/tree/develop/packages/backup/docs).
