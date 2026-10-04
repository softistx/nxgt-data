---
"@nxgt/backup": minor
---

A new package: encrypted, verifiable backups on Bun. `defineBackup` and `bindBackup` with `create`, `list`, `verify` and `restore`. Each entry is compressed with zstd, then encrypted with age to one or more recipients (X25519 or hybrid post-quantum). The encrypted catalog is written next, and the clear manifest last: it pins every object's size and SHA-256. A restore checks each object before decrypting a byte, and each entry's plain digest as it goes. It writes to several repositories at once, with a per-repository outcome; `localRepository`, `directorySource` and `directoryTarget` ship with it.
