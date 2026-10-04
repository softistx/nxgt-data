---
"@nxgt/backup": minor
---

Signed manifests. Pass `signing: { key }` (an Ed25519 private key, PEM) to `bindBackup`, and `create` signs each manifest's exact bytes into `manifest.sig`, put just before the manifest. Pass `trusted: [publicKey, …]` to readers — the public half of `signing.key` by default — and `list`, `verify` and `restore` refuse a manifest that none of them signed, with the new `BackupError` code `SIGNATURE`, before anything else is read. A backup written with the public age keys alone, by anyone who can write the repository, no longer restores. `generateSigningKeys()` makes a key pair; `Created.signed` and `Verified.signatureChecked` say what happened. Without `signing` or `trusted`, nothing changes, save one limit in every mode: a manifest is read no further than 64 MiB (about half a million entries), and `create` refuses to write a larger one.
