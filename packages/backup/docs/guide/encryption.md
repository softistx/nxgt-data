# Encryption

This page covers the keys a backup is encrypted to and opened with, and what
each check — age's, the manifest's, the catalog's, the signature's — proves
and does not.

```ts
import {
	bindBackup,
	defineBackup,
	directorySource,
	directoryTarget,
	localRepository,
} from '@nxgt/backup';

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [
		process.env.BACKUP_RECIPIENT as string,        // age1…, its identity kept offline
		process.env.BACKUP_ESCROW_RECIPIENT as string, // a second key, held elsewhere
	],
});

const { id } = await backups.create(directorySource({ path: '/srv/uploads' }));

// Later, wherever the secret key lives:
await backups.restore(id, directoryTarget({ path: '/srv/restore' }), {
	identities: [process.env.BACKUP_IDENTITY as string], // AGE-SECRET-KEY-1…
});
```

Encryption is [age](https://age-encryption.org), through the
[`age-encryption`](https://www.npmjs.com/package/age-encryption) package
(`~0.3.1`, BSD-3-Clause, by Filippo Valsorda), streaming: a 64 MB entry goes
through at a peak RSS of 88 MB, measured on Bun 1.4.2.

## Keys

| | Looks like | Who holds it | Passed as |
| --- | --- | --- | --- |
| recipient | `age1…` (X25519) or `age1pq1…` (hybrid post-quantum) | the host that runs `create` — it is public | `bindBackup({ recipients })` |
| identity | `AGE-SECRET-KEY-1…` or `AGE-SECRET-KEY-PQ-1…` | whoever restores — nobody else | `restore({ identities })`, `verify({ identities })` |

Make a pair with the `age-keygen` command, or in code:

```ts
import {
	generateHybridIdentity,
	generateIdentity,
	identityToRecipient,
} from 'age-encryption';

const identity = await generateIdentity();          // AGE-SECRET-KEY-1…
const recipient = await identityToRecipient(identity); // age1…

const pqIdentity = await generateHybridIdentity();      // AGE-SECRET-KEY-PQ-1…
const pqRecipient = await identityToRecipient(pqIdentity); // age1pq1…, about 1,960 characters
```

`age-encryption` is installed with this package; `bun add age-encryption`
before importing it yourself, so your project names it.

**Only the restoring side needs the secret key.** `create`, `list` and
`verify` without identities run on the public key alone, so the host that is
being backed up — the one an intruder would be on — holds nothing that opens
its own backups.

### Checked at bind time

`bindBackup` hands each recipient to age once, and refuses one that age
refuses with a bare `TypeError` naming its **position**, never the key:

```ts
const keys = (process.env.BACKUP_RECIPIENTS ?? '').split(',').filter(Boolean);
bindBackup(definition, { repositories, recipients: keys as [string, ...string[]] });
// with the variable unset:
// TypeError: bindBackup: recipients must list at least one age public key
// with 'age1…,age1typo':
// TypeError: bindBackup: recipient 1 is not an age public key (age1… or age1pq1…)
```

The types already refuse a literal `recipients: []`; the check is for a list
built at run time.

Identities are checked the same way when `verify` or `restore` is called,
before anything is read:

```ts
await backups.restore(id, target, { identities: ['AGE-SECRET-KEY-1TYPO'] });
// TypeError: restore: identity 0 is not an age secret key (AGE-SECRET-KEY-…)
```

**A message never quotes a key.** Measured on `age-encryption` 0.3.1, age's
own message for an identity with a bad checksum quotes the whole secret key
(`Invalid checksum in AGE-SECRET-KEY-1…`), so this package drops age's error
rather than passing it on as `cause`. A log line holding one of these errors
holds no secret.

## Several recipients

Every recipient can open every backup on its own; `restore` needs any one of
the matching identities.

```ts
recipients: [primary, escrow],
```

Give a backup at least two: the key you restore with day to day, and one held
somewhere else — a sealed envelope, another person, another vault — for the
day the first is lost. Lose every identity and the backups are noise; there
is no recovery.

`identities` takes several too, which is how a restore works across a key
rotation: pass the old identity and the new one, and each backup opens with
whichever it was encrypted to. The manifest lists each backup's
`recipients` in the clear, so you can tell which key a backup needs before
you go looking for it.

## Hybrid post-quantum keys

An `age1pq1…` recipient is age's hybrid of ML-KEM-768 and X25519: a file
encrypted to it stays closed unless **both** are broken, which protects
backups kept for years against someone storing them today and decrypting
them once a quantum computer exists.

```ts
recipients: [pqRecipient, pqEscrowRecipient],
```

age accepts an X25519 recipient beside a hybrid one, and the package does
not stop you — but then the file is only as strong as its X25519 stanza.
Make every recipient hybrid when that is the point.

## zstd, then age

Each entry is compressed **before** it is encrypted, because encrypted bytes
look random and do not compress. zstd is Bun's own
`CompressionStream('zstd')`, which is why the package needs Bun 1.4. A
million identical bytes are stored in under ten thousand.

Compression before encryption reveals something through sizes: the
manifest records each object's encrypted size in the clear, which is roughly
its compressed size. Someone reading the repository learns how many entries
a backup has and about how well each compressed — not what they hold, nor
their names.

## What it proves, and what it does not

**age** authenticates what it decrypts: every 64 KiB chunk carries a tag, so
a decrypted stream is exactly what was encrypted, with nothing flipped,
reordered or cut off. What age cannot say is **who** encrypted it: a
recipient is a public key, so anyone who has it can write a perfectly valid
age file that your identity opens — and every manifest lists the recipients
in the clear, so read access to the repository is enough to have them.

So two digests are kept beside it:

- **The manifest pins every object's SHA-256**, encrypted bytes. `verify`
  and `restore` copy each object to `tmpDir` and compare it to the manifest
  **before a byte is decrypted**. An object replaced by another valid age
  file — written with the public key — is `INTEGRITY`, and nothing from it
  reaches the target. This check needs no key.
- **The catalog pins every entry's SHA-256**, plain bytes, as the source gave
  them, and the catalog is itself encrypted. An object replaced **and** its
  manifest entry rewritten to match still fails here: the plain bytes differ
  from the catalog's, the stream fails at its end with `INTEGRITY`, and
  `directoryTarget` lands nothing.

That leaves one gap: someone who can **write** to the repository can write
a whole backup of their own — objects, catalog and manifest, all consistent,
since every manifest lists the recipients in the clear — and the digests pass
it. **Signed manifests** close it: `create` signs each manifest with an
Ed25519 key only the writer holds, and a reader given `trusted` public keys
refuses one that none of them signed, with `SIGNATURE`, before reading
anything else — [signing](signing.md). Without `trusted`, that forged backup
still verifies and restores.

| Someone with write access to the repository… | Caught by | When |
| --- | --- | --- |
| flips a byte of an object | the manifest's SHA-256 | `verify` without a key; `restore` before decrypting |
| replaces an object with a valid age file | the manifest's SHA-256 | the same |
| replaces an object and rewrites its manifest entry | the manifest's signature, with `trusted` set; otherwise the catalog's SHA-256 | the signature: every call, first. The catalog: `verify` with identities; `restore`, before the entry lands |
| moves another backup's manifest in | the manifest's `backup` and `id` | every call |
| deletes the manifest | — | the backup no longer exists: not listed, `NOT_FOUND` |
| writes a whole consistent backup of their own | the manifest's signature, with `trusted` set — [signing](signing.md); nothing without it | `list` (in `unreadable`), `verify`, `restore`, before anything else is read |
| edits a signed manifest, or moves another backup's signature in | the manifest's signature, with `trusted` set | the same |
| deletes backups, or the newest so an older one looks latest | nothing here, signed or not | append-only storage, [later](../roadmap.md) |

Next: [signing](signing.md), for who wrote a backup, or
[repositories](repositories.md), for where the bytes go.
