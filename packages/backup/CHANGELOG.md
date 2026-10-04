# @nxgt/backup

## 0.1.0

### Minor Changes

- [#147](https://github.com/softistx/nxgt-data/pull/147) [`8081c94`](https://github.com/softistx/nxgt-data/commit/8081c945b2b8bd9206159b9e76a924654e86242a) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A new package: encrypted, verifiable backups on Bun. `defineBackup` and `bindBackup` with `create`, `list`, `verify` and `restore`. Each entry is compressed with zstd, then encrypted with age to one or more recipients (X25519 or hybrid post-quantum). The encrypted catalog is written next, and the clear manifest last: it pins every object's size and SHA-256. A restore checks each object before decrypting a byte, and each entry's plain digest as it goes. It writes to several repositories at once, with a per-repository outcome; `localRepository`, `directorySource` and `directoryTarget` ship with it.
