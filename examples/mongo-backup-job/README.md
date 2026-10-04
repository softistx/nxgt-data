# mongo-backup-job (example)

A scheduled MongoDB backup on [`@nxgt/backup`](../../packages/backup) and
[`@nxgt/mongo-backup`](../../packages/mongo-backup). It is not published.
Its guide is [Running it in production](../../packages/mongo-backup/docs/guide/operations.md).

| Command | What it does |
| --- | --- |
| `bun run backup` | a full backup when none is younger than a week (or when the oplog no longer reaches the last one), an incremental otherwise; then `verify` with the key, then `prune` |
| `bun run drill` | the newest backup, chain included, restored into a `drill-<uuid>` database, counted, dropped |

Each prints one line of JSON (ids, sizes, counts; never a key nor a
document) and exits non-zero on failure, for the scheduler to alert on.

## Configuration

| Variable | |
| --- | --- |
| `MONGO_URL` | a replica set or a sharded cluster |
| `MONGO_DB` | the database backed up |
| `BACKUP_PATH` | an absolute folder: the local repository |
| `BACKUP_RECIPIENT` | the age public key, `age1…` |
| `BACKUP_IDENTITY_FILE` | a file holding the age secret key, mode `0600` |
| `BACKUP_SIGNING_KEY_FILE` | a file holding the Ed25519 private key, PEM, mode `0600` |

```sh
age-keygen -o identity.txt && chmod 600 identity.txt
bun -e "import { generateSigningKeys } from '@nxgt/backup'; await Bun.write('signing.pem', generateSigningKeys().privateKey)"
chmod 600 signing.pem
```

A crontab:

```
0 * * * *  cd /srv/mongo-backup-job && bun run backup
30 4 * * * cd /srv/mongo-backup-job && bun run drill
```

## Layout

| File | |
| --- | --- |
| `src/config.ts` | `configFromEnv`: the variables, secrets read from files |
| `src/plan.ts` | `kindFor` and `KEEP`: when a full backup is due, and the rotation |
| `src/job.ts` | `jobOf`, `backupJob` and `restoreDrill` |
| `src/index.ts` | the command line |
| `src/job.spec.ts` | the whole cycle against a memory replica set: a full backup, an incremental, a drill, `HISTORY_LOST`, a week on |
