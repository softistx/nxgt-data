# Roadmap

Where `@nxgt/backup` is going. A direction, not a commitment: the version an
item shipped in is the only number on this page.

## Next

- **`@nxgt/mongo-backup`** — a source for MongoDB collections, and a target to
  restore them, as a separate package peering on `@nxgt/backup`: a full
  snapshot of each collection, GridFS files included, and incremental
  backups driven by the change stream — its resume token kept as the
  backup's `position`, so the next backup reads only the collections that
  changed.
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

- **Incremental and differential chains** — 0.6.0: `create(source, { kind:
  'incremental' | 'differential', identities })` builds on the newest backup,
  or the newest full one, and stores only the entries that changed; every
  backup's catalog points to the rest where they are already stored, so
  `restore` and `verify` of any backup give its whole view with no replay.
  A source can give each entry a `fingerprint` — the folder source gives
  size, times and inode — so an unchanged entry is not even read, and a
  `position` handed back to the next backup. A repository that lacks the
  backup built on is left out; `verify` without a key checks the whole
  chain; `prune` keeps every parent a kept backup needs —
  [chains](guide/chains.md).
- **Rotation** — 0.5.0: keep what a retention policy names and remove the rest, one
  repository at a time, under the single-writer lock: `last`, `hourly`,
  `daily`, `weekly`, `monthly`, `yearly`, `within`, and a `maxTotalSize` that
  never goes below the newest `last`; every decision with the rules that
  made it; a **dry run** that says what would go and why; **legal holds**
  that keep a backup whatever the policy says; **clean-up of incomplete
  backups** — what a failed run left without a manifest; and a kept backup
  keeping the backups it builds on. It reads manifests only, so it needs no
  key — [rotation](guide/rotation.md).

- **The single-writer lock** — 0.4.0: `create` takes a lock in every
  repository it writes to, renewed while it runs, so two runs of the same
  backup never write at once and rotation never removes a backup still being
  made; a repository whose lock is held elsewhere fails with `LOCKED`, one
  whose lease could not be renewed in time with `LEASE_LOST`, while the
  others go on; `bindBackup` takes `lock: { lease }`, and reads take no
  lock — [locking](guide/locking.md).
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
