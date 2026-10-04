# mongo-backup-job (example)

A scheduled MongoDB backup on [`@nxgt/mongo-backup`](../../packages/mongo-backup)'s
`mongoBackups`, in two short files (`src/backups.ts` reads the environment, `src/index.ts` runs a command).
It is not published. Its guide is
[Running it in production](../../packages/mongo-backup/docs/guide/operations.md).

```sh
bunx nxgt-mongo-backup keygen /etc/shop-backup.key   # once; keep a copy apart
```

| Command | What it does |
| --- | --- |
| `bun run keygen <path>` | once: `nxgt-mongo-backup keygen`, the key file at `<path>` (mode `0600`, never over a file); prints the recipient only |
| `bun run backup` | `run()`: a full backup when none is younger than a week (or when the oplog no longer reaches the last one), an incremental otherwise, read back with the key, then the rotation |
| `bun run drill` | `drill()`: the newest backup, chain included, restored into a database of its own, counted, dropped |

`backup` and `drill` each print one line of JSON and exit non-zero on failure. `@nxgt/backup` is in `dependencies` though `src/` never imports it: it is `@nxgt/mongo-backup`'s required peer.

| Variable | |
| --- | --- |
| `MONGO_URL` | a replica set (a sharded cluster is untested) |
| `MONGO_DB` | the database backed up |
| `BACKUP_PATH` | an absolute folder: the repository |
| `BACKUP_KEY_FILE` | the file `keygen` wrote, mode `0600` |

```
0 * * * *  cd /srv/mongo-backup-job && bun run backup
30 4 * * * cd /srv/mongo-backup-job && bun run drill
```
