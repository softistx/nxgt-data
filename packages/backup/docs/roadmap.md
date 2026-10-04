# Roadmap

Where `@nxgt/backup` is going. A direction, not a commitment: the version an
item shipped in is the only number on this page.

## Now

- **The single-writer lock** — `create` takes a lock in every repository it
  writes to, renewed while it runs, so two runs of the same backup never write
  at once and rotation can never remove a backup still being made; a
  repository whose lock is held elsewhere fails with the code `LOCKED`, one
  whose lease could not be renewed in time with `LEASE_LOST`, while the others
  go on; `bindBackup` takes `lock: { lease }`, and `list`, `verify` and
  `restore` take no lock —
  [locking](guide/locking.md).

## Next

- **Rotation** — keep what a policy says and remove the rest:
  `keepLast`, `keepHourly`, `keepDaily`, `keepWeekly`, `keepMonthly`,
  `keepYearly`, `keepWithin`, and a `maxTotalSize` that never goes below a
  `keepLast` floor; set **per repository**, aware of incremental chains so a
  base is never removed while a backup needs it; a **dry run** that lists what
  would go and why; a **legal hold** that keeps a backup whatever the policy
  says; and **clean-up of incomplete backups** — the objects a failed run left
  without a manifest — under the single-writer lock. Rotation reads manifests
  only, so it needs no key.
- **Incremental and differential chains** — a backup that stores only what
  changed since a full one, or since the previous one, with the manifest's
  `kind` and `parent` describing the chain.
- **`@nxgt/mongo-backup`** — a source for MongoDB collections, and a target to
  restore them, as a separate package peering on `@nxgt/backup`.
- **Granular restore** — part of a database backup — one collection, say —
  without restoring the rest. `only` already picks whole entries.

## Later

- **MongoDB point-in-time restore** — a backup plus the oplog after it, so a
  restore can stop at any moment, not only at a backup.
- **Automatic restore drills** — restore the latest backup on a schedule into
  a throw-away target and report whether it came back whole.
- **Anonymised restore** — restore into a staging environment with chosen
  fields masked or replaced on the way.
- **S3 Object Lock and append-only credentials** — a repository the backed-up
  host can add to and never delete from, so an intruder on that host cannot
  remove the backups either.

## Not planned

- **Content-addressed deduplication, in the first major version** — splitting
  entries into chunks shared between backups saves space, but makes every
  object depend on others, a restore depend on an index, and a backup
  impossible to open with `age` and `zstd` alone. Incremental chains give
  most of the saving and keep the format readable by hand.
- **Postgres point-in-time recovery** — continuous WAL archiving is a
  database server's job, done well by pgBackRest and WAL-G. A logical dump
  as an entry works today —
  [a `pg_dump` source](guide/sources-and-targets.md#writing-a-source).

## Shipped

- **An S3 repository** — 0.3.0: backups kept in any S3-compatible object
  store, beside or instead of a local folder, through your own Bun `S3Client`
  (`s3Repository`): one PUT up to 64 MiB, so an object is visible whole or
  not at all, parts above it, and the stored size read back after every
  write before it counts as done — [repositories](guide/repositories.md).
- **Signed manifests** — 0.2.0: an Ed25519 signature over each manifest,
  checked against your `trusted` public keys by `list`, `verify` and
  `restore` before anything else is read, so a backup proves it was written
  by you and not by someone who can write to the repository — every manifest
  holds the public age keys in the clear —
  [how to sign and check](guide/signing.md).
- **Full, encrypted, verifiable backups** — 0.1.0, the first release: a
  format in which each entry is compressed with zstd, then encrypted with age
  to one or more recipients, behind an encrypted catalog and a clear manifest
  written last that pins every object; a local repository; writing to
  several repositories at once, with an outcome for each; `verify`, with or
  without a key; `restore`, with `only` for chosen entries; and
  `directorySource` and `directoryTarget`.

The full history is in [CHANGELOG.md](../CHANGELOG.md).
