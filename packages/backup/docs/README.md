# `@nxgt/backup` documentation

Encrypted, verifiable backups on Bun: each entry compressed with zstd, then
encrypted with age, stored in one or several repositories — a local folder,
an S3 bucket — under a single-writer lock, with a clear manifest written last that pins every object
and, with a signing key, an Ed25519 signature that proves who wrote it; incremental and differential
backups that store only what changed and still restore whole; and rotation by a retention
policy, with legal holds. It runs on Bun 1.4 or later
only — zstd, hashing and file reads are Bun's own — and its one dependency is
`age-encryption`. Its peer is `typescript`.

| Page | Read it when |
| --- | --- |
| [Getting started](guide/getting-started.md) | you want a first backup and a first restore: `defineBackup`, `bindBackup`, `create`, `list`, `verify` and `restore`, every option and result, a first `prune`, a nightly job, and a restore drill in a spec |
| [Chains](guide/chains.md) | you want to store only what changed: `create(source, { kind: 'incremental' \| 'differential', identities, from })`, what each builds on, the whole-view catalog that restores with no replay, how "unchanged" is decided, the folder's fingerprint, a source of your own with `fingerprint` and `position`, a weekly schedule and incremental against differential, several repositories, `Verified.chain`, changing recipients, and the key the creating host then holds |
| [Rotation](guide/rotation.md) | backups pile up: `prune` and its `KeepPolicy` — `last`, `hourly` to `yearly` in UTC, `within`, `maxTotalSize` and its floor — the reasons each decision gives, a dry run first, a policy per repository, legal holds with `hold` and `unhold`, the clean-up of incomplete backups, the lock and `LEASE_LOST`, and the permissions it needs |
| [Format](guide/format.md) | you want to know what lands in a repository — `<backup>/<id>/0.age … catalog.age, manifest.sig, manifest.json`, `<backup>/locks/` and `<backup>/holds/` — what is in the clear and what is not, the manifest's `kind` and `parent`, the catalog's `in`, `fingerprint` and `position`, why the manifest goes last, how ids sort, and how to open a backup by hand with `age` and `zstd` |
| [Encryption](guide/encryption.md) | you are choosing keys: recipients and identities, hybrid post-quantum `age1pq1…` keys, several recipients, why zstd comes before age, and what age proves and what the manifest, the catalog and the signature add |
| [Signing](guide/signing.md) | you want a backup to prove who wrote it: `signing` and `trusted`, `generateSigningKeys`, what `create` writes and what readers refuse with `SIGNATURE`, the bind-time `TypeError`s, changing the key, and checking a signature with `openssl` |
| [Repositories](guide/repositories.md) | you are deciding where backups live: `localRepository` and how it writes; `s3Repository` on Bun's `S3Client` — options, how it writes and reads, the lifecycle rule for abandoned uploads, and the permissions it needs; several repositories at once and `PARTIAL` / `NOT_STORED`; and the `Repository` contract for writing your own, and what the lock needs of it |
| [Sources and targets](guide/sources-and-targets.md) | you back up something other than a folder, or restore somewhere other than one: `directorySource`, `directoryTarget`, and the `BackupSource` / `RestoreTarget` contracts with a database dump and an in-memory target |
| [Locking](guide/locking.md) | two runs might overlap — a cron job slower than its interval, a killed process: the single-writer lock `create`, `prune`, `hold` and `unhold` take, `LOCKED` and `LEASE_LOST`, `lock.lease` and clock skew, what the store must promise, what a lock file looks like, and clearing one by hand after a crash |
| [Errors](guide/errors.md) | you are handling a failure: `BackupError`, its eight codes and its fields, the bare `TypeError`s, and a handler for a scheduled job |
| [Upgrading](upgrading.md) | you are moving from one minor to the next: what to change, and what a repository you already have needs — from 0.5, upgrade every reader and pruner before the first incremental |
| [Troubleshooting](troubleshooting.md) | a call threw and you have the message, a backup is missing from `list` or in `unreadable`, an incremental has nothing to build on or read every entry again, `prune` kept more than you expected, or the run is out of room |
| [Roadmap](roadmap.md) | you want to know what is coming — granular restore, restore drills, append-only storage — what has been ruled out, and what has shipped, the MongoDB source in `@nxgt/mongo-backup` included |

The [README](../README.md) is the short version: install, keys, an example
for each operation, signing, rotation, the API, the errors and the traps.
