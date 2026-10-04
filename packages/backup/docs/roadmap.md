# Roadmap

Where `@nxgt/backup` is going. A direction, not a commitment: the version an
item shipped in is the only number on this page.

## Now

- **Full, encrypted, verifiable backups** — 0.1.0, the first release:
  `defineBackup` and `bindBackup` with `create`, `list`, `verify` and
  `restore`; each entry compressed with zstd, then encrypted with age to one
  or more recipients, X25519 or hybrid post-quantum; an encrypted catalog,
  and a clear manifest written last that pins every object; a restore that
  checks each object before decrypting it and each entry as it streams;
  several repositories at once with an outcome for each; `localRepository`,
  `directorySource` and `directoryTarget`; `BackupError` with `NOT_FOUND`,
  `INTEGRITY`, `DECRYPT`, `PARTIAL` and `NOT_STORED`.

## Next

- **Signed manifests** — an ed25519 signature over each manifest, checked by
  `list`, `verify` and `restore`, so a backup proves it was written by you
  and not by someone who can write to the repository — every manifest holds
  the public keys in the clear —
  [what that closes](guide/encryption.md#what-it-proves-and-what-it-does-not).
- **An S3 repository** — backups kept in any S3-compatible object store,
  beside or instead of a local folder.
- **A single-writer lock** — one `create`, rotation or clean-up at a time per
  backup and repository, so two jobs started together cannot step on each
  other.
- **Rotation** — keep what a policy says and remove the rest:
  `keepLast`, `keepHourly`, `keepDaily`, `keepWeekly`, `keepMonthly`,
  `keepYearly`, `keepWithin`, and a `maxTotalSize`; set **per repository**,
  aware of incremental chains so a base is never removed while a backup
  needs it; a **dry run** that lists what would go; a **legal hold** that
  keeps a backup whatever the policy says; and **clean-up of incomplete
  backups** — the objects a failed run left without a manifest. Rotation
  reads manifests only, so it needs no key.
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

_Nothing before 0.1.0: see Now._
