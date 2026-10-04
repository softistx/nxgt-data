# Upgrading

What to change in your code when you move `@nxgt/backup` from one minor to
the next. Each minor is a `0.x` release, so each can ask for something; the
[changelog](https://github.com/softistx/nxgt-data/blob/develop/packages/backup/CHANGELOG.md)
has every change, and this page has only what you have to do.

## 0.1 → 0.2

Nothing breaks for callers: 0.2.0 adds signed manifests — the `signing` and
`trusted` options, `generateSigningKeys`, `Created.signed` and
`Verified.signatureChecked` — and renames nothing. Without `signing` or
`trusted`, every call behaves as in 0.1, and a 0.1 backup reads as before —
save one limit that is new in every mode, below. A literal of `Created` or
`Verified` you build yourself (a fake `BoundBackup` in a spec) needs the new
field. Then three things are worth doing.

### A manifest is now at most 64 MiB

0.2.0 reads no more than 64 MiB of a manifest — a repository is not trusted
with its size — and `create` refuses to write a larger one. That is about
half a million entries; a 0.1 backup with more is `INTEGRITY` to
`verify`/`restore` and `unreadable` to `list`, and a `create` that 0.1
finished now throws once its objects are stored. Split such a source into
several backups —
[the read](troubleshooting.md#verify-on-app-the-manifest-is-larger-than-64-mib-repository-local),
[the write](troubleshooting.md#create-on-app-the-manifest-would-be-larger-than-64-mib-split-the-source-into-several-backups).

### Handle the new `SIGNATURE` code

`BackupErrorCode` has a new member, `SIGNATURE`: a reader with `trusted`
keys found a manifest that is not signed, or not by one of them —
[signing](guide/signing.md#reading-list-verify-restore). A `switch` on
`error.code` gets a new case:

```ts
import { BackupError } from '@nxgt/backup';

function shouldAlert(error: unknown): boolean {
	if (!(error instanceof BackupError)) return false;
	switch (error.code) {
		case 'INTEGRITY':
		case 'DECRYPT':
		case 'NOT_FOUND':
		case 'SIGNATURE': // 0.2.0: not written by a key you trust
			return true;
		case 'PARTIAL':
		case 'NOT_STORED':
			return false;
		default: {
			const unhandled: never = error.code;
			return unhandled;
		}
	}
}
```

A switch with an exhaustive check like the `default` above stops compiling
on 0.2.0 until it has the `SIGNATURE` case — which is what it is for. One
without it compiles, and sends `SIGNATURE` wherever its fall-through goes.

### Sign, and give every reader `trusted`

Signing is off unless you turn it on, and a 0.1-style reader — no
`trusted` — still verifies and restores a whole consistent backup written by
anyone who can write to the repository. Make a key pair once, give the
private key to the host that runs `create`, and the public key to every
other:

```ts
import { bindBackup, defineBackup, generateSigningKeys, localRepository } from '@nxgt/backup';

const { privateKey, publicKey } = generateSigningKeys(); // once, then store both

const writer = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
	signing: { key: privateKey }, // 0.2.0
});

const reader = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
	trusted: [publicKey], // 0.2.0
});
```

[Signing](guide/signing.md) has the keys, `openssl`, and what each side
refuses.

### Backups made before signing was on

A reader with `trusted` keys refuses every backup without a signature, and
the backups made by 0.1 — or by 0.2 before `signing` was set — have none.
For that reader they leave `list`'s `backups` for its `unreadable`, and
`verify` and `restore` reject them with:

```text
restore on "uploads": the manifest is not signed (repository "local")
```

Nothing is signed after the fact. Pick one, per repository:

- **Keep a reader without `trusted`** — a separate `bindBackup` for restoring
  the old backups — until the last unsigned backup has expired, then drop
  it. That reader trusts whatever is in the repository, so use it only for
  ids made before the switch.
- **Re-make them**: run `create` with `signing` on, then remove the unsigned
  backups yourself — the package deletes nothing yet. A new backup holds the
  source as it is now, so this gives up the old points in time.

The writer itself is a reader too: with `signing` alone, its `list` and
`verify` check its own public key, so the old ids land in its `unreadable`
as well.
