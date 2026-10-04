# @nxgt/backup

## 0.4.0

### Minor Changes

- [#152](https://github.com/softistx/nxgt-data/pull/152) [`3667c24`](https://github.com/softistx/nxgt-data/commit/3667c24a1150df83939e8fd89cba8dcda7d5b2e8) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A single-writer lock: `create` now takes a lock in every repository it writes to, renewed while it runs, so two runs of the same backup never write to one repository at once. A repository whose lock is held elsewhere fails with the new code `LOCKED`; one whose lease could not be renewed in time starts no further write there and fails with the new code `LEASE_LOST`. The other repositories go on. `bindBackup` takes `lock: { lease }` (5 minutes by default). `list` no longer fails when a backup disappears between its listing and its read.

## 0.3.0

### Minor Changes

- [#150](https://github.com/softistx/nxgt-data/pull/150) [`9dd96e7`](https://github.com/softistx/nxgt-data/commit/9dd96e757959d7cf3e61fa61ccec5b16b61dff06) Thanks [@SteveGT96](https://github.com/SteveGT96)! - An S3 repository: `s3Repository({ client, prefix, partSize })` keeps backups in any S3-compatible bucket through your own Bun `S3Client`, beside or instead of a local folder. Up to 64 MiB an object goes in one PUT, visible whole or not at all; a larger one is streamed from disk in parts. Every write reads the stored size back before it counts as done. Restores and verifies now stop reading an object as soon as it runs past the size its manifest gives, from any repository.

## 0.2.0

### Minor Changes

- [#148](https://github.com/softistx/nxgt-data/pull/148) [`79593ff`](https://github.com/softistx/nxgt-data/commit/79593ffa179f5ee32389c0a3bee973920b2a889a) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Signed manifests. Pass `signing: { key }` (an Ed25519 private key, PEM) to `bindBackup`, and `create` signs each manifest's exact bytes into `manifest.sig`, put just before the manifest. Pass `trusted: [publicKey, …]` to readers — the public half of `signing.key` by default — and `list`, `verify` and `restore` refuse a manifest that none of them signed, with the new `BackupError` code `SIGNATURE`, before anything else is read. A backup written with the public age keys alone, by anyone who can write the repository, no longer restores. `generateSigningKeys()` makes a key pair; `Created.signed` and `Verified.signatureChecked` say what happened. Without `signing` or `trusted`, nothing changes, save one limit in every mode: a manifest is read no further than 64 MiB (about half a million entries), and `create` refuses to write a larger one.

## 0.1.0

### Minor Changes

- [#147](https://github.com/softistx/nxgt-data/pull/147) [`8081c94`](https://github.com/softistx/nxgt-data/commit/8081c945b2b8bd9206159b9e76a924654e86242a) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A new package: encrypted, verifiable backups on Bun. `defineBackup` and `bindBackup` with `create`, `list`, `verify` and `restore`. Each entry is compressed with zstd, then encrypted with age to one or more recipients (X25519 or hybrid post-quantum). The encrypted catalog is written next, and the clear manifest last: it pins every object's size and SHA-256. A restore checks each object before decrypting a byte, and each entry's plain digest as it goes. It writes to several repositories at once, with a per-repository outcome; `localRepository`, `directorySource` and `directoryTarget` ship with it.
