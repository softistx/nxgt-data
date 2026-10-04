# @nxgt/backup

## 0.2.0

### Minor Changes

- [#148](https://github.com/softistx/nxgt-data/pull/148) [`79593ff`](https://github.com/softistx/nxgt-data/commit/79593ffa179f5ee32389c0a3bee973920b2a889a) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Signed manifests. Pass `signing: { key }` (an Ed25519 private key, PEM) to `bindBackup`, and `create` signs each manifest's exact bytes into `manifest.sig`, put just before the manifest. Pass `trusted: [publicKey, …]` to readers — the public half of `signing.key` by default — and `list`, `verify` and `restore` refuse a manifest that none of them signed, with the new `BackupError` code `SIGNATURE`, before anything else is read. A backup written with the public age keys alone, by anyone who can write the repository, no longer restores. `generateSigningKeys()` makes a key pair; `Created.signed` and `Verified.signatureChecked` say what happened. Without `signing` or `trusted`, nothing changes, save one limit in every mode: a manifest is read no further than 64 MiB (about half a million entries), and `create` refuses to write a larger one.

## 0.1.0

### Minor Changes

- [#147](https://github.com/softistx/nxgt-data/pull/147) [`8081c94`](https://github.com/softistx/nxgt-data/commit/8081c945b2b8bd9206159b9e76a924654e86242a) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A new package: encrypted, verifiable backups on Bun. `defineBackup` and `bindBackup` with `create`, `list`, `verify` and `restore`. Each entry is compressed with zstd, then encrypted with age to one or more recipients (X25519 or hybrid post-quantum). The encrypted catalog is written next, and the clear manifest last: it pins every object's size and SHA-256. A restore checks each object before decrypting a byte, and each entry's plain digest as it goes. It writes to several repositories at once, with a per-repository outcome; `localRepository`, `directorySource` and `directoryTarget` ship with it.
