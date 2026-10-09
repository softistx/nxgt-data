# @nxgt/backup

## 0.6.2

### Patch Changes

- [#197](https://github.com/softistx/nxgt-data/pull/197) [`0895cc1`](https://github.com/softistx/nxgt-data/commit/0895cc1735181ba6ee624534b052f794d801433a) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The declaration files now import each other with a `.js` extension, so a project with `moduleResolution: "nodenext"` (or `node16`) sees every export. Before, a name re-exported through a relative module was missing there (TS2305), as `@nxgt/mongo`'s were.

## 0.6.1

### Patch Changes

- [#158](https://github.com/softistx/nxgt-data/pull/158) [`af141a3`](https://github.com/softistx/nxgt-data/commit/af141a3f067efdbf1f222e8227b6a9f2b44c5d66) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Docs: the MongoDB source and target have shipped, as the separate package `@nxgt/mongo-backup`. The README's 0.x note, the docs index and the roadmap now say so.

- [#160](https://github.com/softistx/nxgt-data/pull/160) [`33d6306`](https://github.com/softistx/nxgt-data/commit/33d63062dc350f3d724aca127e52c5c75f53280d) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `localRepository`: a `put` racing a `delete` of its folder retries on `ENOENT` anywhere on the way, and up to five times. Before, it retried only when the folder was gone at the moment of the check, so a race lost while another `put` had made the folder again failed the write.

## 0.6.0

### Minor Changes

- [#156](https://github.com/softistx/nxgt-data/pull/156) [`9d7a5ba`](https://github.com/softistx/nxgt-data/commit/9d7a5baf1992c805bd410d5c031d34463c4b7bf4) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Incremental and differential backups: `create(source, { kind: 'incremental' | 'differential', identities })` builds on the newest backup (or the newest full one), stores only the entries that changed, and points to the rest where they are already stored — so `restore` and `verify` of any backup give its whole view, with no replay. A source can give each entry a `fingerprint` (the directory source gives size, times and inode) so an unchanged entry is not even read, and a `position` (a change stream's resume token) handed back as `since.position` to the next backup. A repository whose copy of the chain is not whole is left out; a base encrypted to other recipients is refused (make a full backup after changing recipients). The directory fingerprint is left out for a file changed within the last two seconds, so a coarse clock cannot hide a write. `Created`, `BackupInfo` and the manifest gain `kind` and `parent`; `Verified` gains `chain`. Prune keeps what a kept backup builds on, and now also the parent of a backup whose manifest it cannot read. **Upgrade every process that prunes before creating the first incremental**: a 0.5 prune cannot read an incremental manifest and would remove its base.

## 0.5.0

### Minor Changes

- [#154](https://github.com/softistx/nxgt-data/pull/154) [`0ec34cb`](https://github.com/softistx/nxgt-data/commit/0ec34cb8553e170aede3762ad9043f77e8fb9616) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Backup rotation: `prune({ keep, from, dryRun })` applies a retention policy to one repository under the lock — `last`, `hourly`, `daily`, `weekly`, `monthly`, `yearly`, `within` and `maxTotalSize` (never below the newest `last`, or the newest backup) — and removes the rest, with backups that never got a manifest once they are older than `incompleteAfter`. Every decision says which rules kept a backup or why it went; `dryRun` removes nothing. `hold(id)` puts a legal hold, in every repository that holds the backup, that `prune` always respects until `unhold(id)`, and `list` reports it. A kept backup keeps the backups it builds on. The `LOCKED` message now reads "another create, prune or hold has the lock". A local repository now removes the folders a delete leaves empty.

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
