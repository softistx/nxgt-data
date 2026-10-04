# Signing

This page covers signed manifests: proving that a backup was written by the
host holding your signing key, and not by anyone else who can write to the
repository.

```ts
import {
	bindBackup,
	defineBackup,
	directorySource,
	generateSigningKeys,
	localRepository,
} from '@nxgt/backup';

const uploads = defineBackup({ name: 'uploads' });
const repositories = [localRepository({ path: '/mnt/backups' })] as const;
const recipients = [process.env.BACKUP_RECIPIENT as string] as const; // age1…

const { privateKey, publicKey } = generateSigningKeys(); // once; keep both

// Where backups are made: the private key.
const writer = bindBackup(uploads, {
	repositories,
	recipients,
	signing: { key: privateKey },
});
const created = await writer.create(directorySource({ path: '/srv/uploads' }));
// created.signed === true

// Everywhere else: the public key only.
const reader = bindBackup(uploads, {
	repositories,
	recipients,
	trusted: [publicKey],
});
const verified = await reader.verify(created.id);
// verified.signatureChecked === true
```

A signature is Ed25519, through `node:crypto`, which Bun implements. The
keys are PEM text, so `openssl` makes the same ones — see
[keys](#keys).

## Why it is needed

age proves that a stream was not altered, not who wrote it: the recipients
are public keys, and every manifest lists them in the clear. So anyone who
can **write** to the repository can make a whole backup of their own —
objects, catalog and manifest, all consistent — that `verify` passes and
`restore` writes out. The manifest's and catalog's digests catch an altered
backup, never a forged one —
[what each check proves](encryption.md#what-it-proves-and-what-it-does-not).

A signature closes that: a reader given `trusted` keys refuses a manifest
that none of them signed, before it reads anything else of the backup.

## Options

Both are `bindBackup` options, beside `repositories`, `recipients` and
`tmpDir` ([getting started](getting-started.md#binding-it)).

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `signing` | `{ key: string }` | none | an Ed25519 private key, PEM (PKCS#8, `-----BEGIN PRIVATE KEY-----`). `create` signs every manifest it writes with it. Give it only where backups are made |
| `trusted` | `[string, ...string[]]` | the public half of `signing.key`, when `signing` is given; none otherwise | Ed25519 public keys, PEM (SPKI, `-----BEGIN PUBLIC KEY-----`). `list`, `verify` and `restore` read only a manifest one of them signed |

```ts
interface BindBackupOptions {
	repositories: readonly [Repository, ...Repository[]];
	recipients: readonly [string, ...string[]];
	tmpDir?: string | undefined;
	signing?: { key: string } | undefined;
	trusted?: readonly [string, ...string[]] | undefined;
}
```

What each combination does:

| `signing` | `trusted` | `create` | `list`, `verify`, `restore` |
| --- | --- | --- | --- |
| — | — | signs nothing | check nothing: **the 0.1 behaviour**, save the 64 MiB limit on a manifest |
| given | — | signs | require a signature by `signing.key` |
| given | given | signs | require a signature by one of `trusted`, which must hold `signing.key`'s public half |
| — | given | **refused**: a reader cannot write what it could not read | require a signature by one of `trusted` |

A writer is also a reader: with `signing` alone, its own `list` and `verify`
check what it wrote. A reader is not a writer: with `trusted` and no
`signing`, `create` throws before anything is read or written:

```text
create on "uploads": trusted keys are set but no signing key, so this backup could not read what it writes
```

## Writing: `create`

With `signing`, `create` signs the **exact bytes** of `manifest.json` and
stores the 64 raw signature bytes as `manifest.sig`, beside it. In every
repository the signature is put **just before** the manifest:

```text
uploads/20261003T221500123Z-9f3a61c0/
  0.age
  …
  catalog.age
  manifest.sig     ← 64 bytes, put just before the manifest
  manifest.json    ← put last: the backup exists from here
```

A backup exists once its manifest does, so a signed backup never stands
without its signature. A run that stops between the two leaves a signature
with no manifest: not a backup, as before —
[format](format.md#the-manifest).

```ts
interface Created {
	// … as in getting started
	signed: boolean; // whether its manifest was signed: `signing` was given
}
```

`storedSize` counts the objects and the catalog, not the manifest nor its
signature.

## Reading: `list`, `verify`, `restore`

With `trusted` — given, or derived from `signing` — every call that reads a
backup fetches its manifest's bytes, then `manifest.sig`, and checks the
signature against those bytes **before they are parsed** and before any
other object of the backup is read. A repository is not trusted with the
sizes either: at most 65 bytes of `manifest.sig` are read, and at most
64 MiB and one byte of `manifest.json` — about half a million entries; a larger one is
`INTEGRITY`, and `create` refuses to write one.

- `verify` and `restore` reject with a `BackupError` whose `code` is
  `SIGNATURE`, and nothing lands in the target:

  ```text
  restore on "uploads": the manifest is not signed (repository "local")
  restore on "uploads": no trusted key signed the manifest (repository "local")
  ```

  The first when there is no `manifest.sig`; the second when there is one
  and no trusted key made it — another key, a manifest edited after it was
  signed, or a signature moved in from another backup.

- `list` does not throw for it: the id goes into `unreadable`, as for a
  manifest that does not read. `verify` on it gives the `SIGNATURE` error.

```ts
import { BackupError } from '@nxgt/backup';

try {
	await reader.restore(id, target, { identities: [identity] });
} catch (error) {
	if (error instanceof BackupError && error.code === 'SIGNATURE') {
		// not written by a key you trust: do not restore it
	}
	throw error;
}
```

`Verified` says whether the signature was checked:

```ts
interface Verified {
	// … as in getting started
	signatureChecked: boolean; // whether trusted keys are set, so the signature was checked
}
```

## Without `signing` or `trusted`

Nothing is signed and nothing is checked — as in 0.1. In that mode,
**a whole consistent backup written by someone else still verifies and
restores**. A signature only protects a reader that asks for one, so give
`trusted` to **every** reader: the restore host, the job that verifies, the
restore drill. A reader without it reads a forged backup and a signed one
alike.

`verified.signatureChecked` is `false` in that mode; a scheduled check can
assert it:

```ts
const verified = await reader.verify(id);
if (!verified.signatureChecked) {
	throw new Error('verify ran without trusted keys');
}
```

## Keys

`generateSigningKeys()` makes a pair, both halves as PEM text:

```ts
import { chmod } from 'node:fs/promises';
import { generateSigningKeys, type SigningKeys } from '@nxgt/backup';

const keys: SigningKeys = generateSigningKeys();
await Bun.write('signing.pem', keys.privateKey);    // -----BEGIN PRIVATE KEY-----
await Bun.write('signing.pub.pem', keys.publicKey); // -----BEGIN PUBLIC KEY-----
await chmod('signing.pem', 0o600);                  // the backup user's alone
```

```ts
interface SigningKeys {
	privateKey: string; // PKCS#8 PEM. Keep it with the writer
	publicKey: string;  // SPKI PEM. Give it to every reader
}

function generateSigningKeys(): SigningKeys;
```

OpenSSL 3 makes the same kind of keys:

```sh
openssl genpkey -algorithm ed25519 -out signing.pem
openssl pkey -in signing.pem -pubout -out signing.pub.pem
```

A PEM spans several lines, which an environment variable holds badly; read
it from a file:

```ts
signing: { key: await Bun.file('/etc/backup/signing.pem').text() },
```

**Where each half goes:**

- The **private key** lives only where backups are made. Whoever holds it
  can sign a backup you will trust.
- **Readers** — the hosts that verify or restore, the restore drill — get
  only the public key, as `trusted`. A private key there is refused (see
  below): a reader holding it could also sign.

### Checked at bind time

`bindBackup` reads every key once, after the recipients, and refuses one
that could never work with a bare `TypeError`. The message names the
option and the **position**, never quotes the key, and carries no `cause`:
Node's own error, which could, is dropped.

```ts
bindBackup(definition, { repositories, recipients, signing: { key: 'not a key' } });
// TypeError: bindBackup: signing.key is not an Ed25519 private key (PEM, PKCS#8)
```

| Message | When |
| --- | --- |
| `bindBackup: signing.key is not an Ed25519 private key (PEM, PKCS#8)` | `signing.key` is not a string, not PEM, a key of another type (RSA, EC), a public key, or a passphrase-protected PEM |
| `bindBackup: trusted 0 is a private key; give its public key` | entry 0 of `trusted` holds `PRIVATE KEY`: give its public half |
| `bindBackup: trusted 0 is not an Ed25519 public key (PEM, SPKI)` | entry 0 of `trusted` is not a string, not PEM, or a key of another type |
| `bindBackup: trusted must list at least one public key` | `trusted: []` — a list built at run time came out empty. Leave `trusted` out to mean "none" |
| `bindBackup: trusted does not hold the public key of signing.key, so this backup could not read what it writes` | both are given, and `trusted` leaves out the writer's own public key |

The types refuse a literal `trusted: []`; the check is for a list built at
run time. Every message is in [troubleshooting](../troubleshooting.md).

## Changing the signing key

`trusted` takes several keys so that a key can change without a backup
becoming unreadable:

1. Add the **new** public key to every reader's `trusted`, beside the old
   one.
2. Switch the writer's `signing.key` to the new private key. Give the
   writer both public keys in `trusted` too, if it also lists or verifies
   the old backups.
3. Once the last backup signed by the old key has expired, remove the old
   public key from every `trusted`.

```ts
const reader = bindBackup(uploads, {
	repositories,
	recipients,
	trusted: [
		await Bun.file('/etc/backup/signing-2026.pub.pem').text(), // the old key, until its backups expire
		await Bun.file('/etc/backup/signing-2027.pub.pem').text(), // the new one
	],
});
```

Turning signing on for a repository that already holds unsigned backups is
the same problem: [upgrading](../upgrading.md#01--02).

## Checking a signature by hand

The signature is a raw Ed25519 signature over the file's bytes, so OpenSSL 3
checks it without this package:

```sh
cd /mnt/backups/uploads/20261003T221500123Z-9f3a61c0
openssl pkeyutl -verify -pubin -inkey signing.pub.pem -rawin \
  -in manifest.json -sigfile manifest.sig
# Signature Verified Successfully
# — or, for a manifest changed by a single byte:
# Signature Verification Failure
```

Measured with OpenSSL 3.5.9 (the `alpine/openssl` image) on a signature this
package made on Bun. **macOS's own `openssl` is LibreSSL** (3.3.6 measured),
which has no Ed25519: it stops at `unable to load Public Key`. Use OpenSSL 3
— from Homebrew, or the image:

```sh
docker run --rm -v "$PWD:/w" -w /w alpine/openssl pkeyutl -verify -pubin \
  -inkey signing.pub.pem -rawin -in manifest.json -sigfile manifest.sig
```

## What it proves, and what it does not

- **It proves who wrote the manifest**, and through it every object: the
  manifest pins each object's SHA-256, and the encrypted catalog each
  entry's. A forged backup, an edited manifest and a signature moved in from
  another backup are all `SIGNATURE`.
- **It does not stop deletion or rollback.** Someone with write access can
  still delete backups, or delete the newest so that an older, genuinely
  signed one looks like the latest. That needs storage the backed-up host
  cannot delete from — S3 Object Lock, append-only credentials — which is
  [on the roadmap](../roadmap.md).
- **It hides nothing.** The manifest stays in the clear, signed or not; age
  does the hiding — [encryption](encryption.md).

Next: [errors](errors.md), for handling `SIGNATURE` beside the other codes.
