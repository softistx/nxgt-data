---
"@nxgt/mongo-backup": minor
---

`mongoBackups()` is the new entry point, with the decisions made for you:
- one key file, written by `nxgt-mongo-backup keygen <path>` (or `generateKeyFile`), that holds the age identity and the signing key;
- `run()`: a full backup a week and incrementals in between, a full one at once on `HISTORY_LOST`, each verified with the key, then the rotation;
- `restore({ into, at?, collections?, as?, documents?, replace? })`: the whole database or part of it, the newest backup or the one at a given time; `replace` is for whole collections and is refused with `documents`, and an `into` that is not a `Db` or an invalid `at` date is refused;
- `drill()`: a restore check that leaves nothing behind.

The new error code `KEY_FILE` covers a key file that is not there (its `ENOENT` as the `cause`), one others than its owner can read or write, or one `keygen` did not write; no message quotes a key. `mongoBackups` refuses, when it is called and not after a backup is stored, a `keep` that names no valid rule, an empty or ambiguous repository list, a relative `tmpDir`, and a backup name `@nxgt/backup` would refuse — a database named `MyShop` needs `name: 'myshop'`. `age-encryption` is now a dependency. `mongoSource`, `mongoTarget` and `restoreCollections` remain for what `mongoBackups` does not do.
