# `@nxgt/mongo-backup` documentation

Encrypted, signed backups of a MongoDB database on `@nxgt/backup`.
`mongoBackups` is the way in: one key file, a full backup a week and
incrementals in between, each read back and rotated, a restore of a whole
database or part of it, and a drill. Underneath, `mongoSource` reads a full
backup in one snapshot at one cluster time and incrementals from the change
stream, and `mongoTarget` and `restoreCollections` land each collection
whole or not at all. It runs on Bun, against a replica set (a sharded
cluster is untested). Its peers are `@nxgt/backup`, `mongodb` 7 and
`typescript`.

| Page | Read it when |
| --- | --- |
| [Getting started](guide/getting-started.md) | you want a first backup, restore and drill: the key file (`nxgt-mongo-backup keygen`, `generateKeyFile`, `readKeyFile`, `KEY_FILE`), `mongoBackups` and its options and defaults, what `run`, `restore`, `drill`, `list` and `binding` return and throw; then the lower level — `mongoSource`, choosing collections, what a snapshot guarantees, the window it must fit in, views and GridFS, and a job by hand |
| [Incremental](guide/incremental.md) | you want to know what an incremental stores, or make them by hand: what the change stream records, updates and post-images, dotted field names, the collections a chain follows and when a change to `collections` takes effect, renames into and out of them, a dropped database, where the next backup resumes, the oplog window and `HISTORY_LOST`, and a weekly schedule |
| [Restore](guide/restore.md) | you want to know what a restore does — `mongoBackups`' `restore` included — or restore by hand: `mongoTarget` and its options, the order entries land in, staging under `nxgt-restore-<uuid>`, `EXISTS` and `replace`, how changes are staged and applied, renames and `EXISTS`, one target per restore, restoring one collection with `only`, restoring into another database, what a failure leaves, restoring into the database you back up, and restoring part of a backup with `restoreCollections` — some collections and views, under other names, whole or only the documents a query takes |
| [Format](guide/format.md) | you want to know what a backup holds: `metadata/<name>`, `documents/<name>` and `changes/<n>`, their bytes, the recorded position and how it says which collections a chain follows, the fingerprints, and reading a backup with `bsondump` without this package |
| [Running it in production](guide/operations.md) | you are putting `mongoBackups` on a schedule: the key file on the job host, `run` hourly and what it does on `HISTORY_LOST` and on the repository's lock, the oplog and snapshot windows, alerting on failure, fallback and silence, `drill`, forcing a full backup, the `restore` call for each thing you may need back, and moving from a job by hand |
| [Errors](guide/errors.md) | you are handling a failure: `MongoBackupError`, its eight codes and every message — `KEY_FILE` and the `NOT_FOUND`s of `mongoBackups` among them — the driver errors that pass through, the bare `TypeError`s, and a handler for `run` on a schedule |
| [Troubleshooting](troubleshooting.md) | a call threw and you have the message |
| [Roadmap](roadmap.md) | you want to know what is coming, and what has been ruled out |

The [README](../README.md) is the short version: install, the key file,
one example for `run`, `restore` and `drill`, the lower level, the API, the
errors and the traps. Repositories, keys,
signing, rotation and the chain rules are `@nxgt/backup`'s —
[its documentation](https://github.com/softistx/nxgt-data/tree/develop/packages/backup/docs).
