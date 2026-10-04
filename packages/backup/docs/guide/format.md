# Format

This page says what a backup leaves in a repository, what is readable there
without a key and what is not, and how to open it without this package.

```text
/mnt/backups/                          ← localRepository({ path: '/mnt/backups' })
  uploads/                             ← the definition's name
    locks/                             ← the single-writer lock: one file per running create, prune or hold
      20261004T221500123Z-1a2b3c4d.json
    holds/                             ← legal holds: one file per held backup
      20260611T221500342Z-77ac1e09.json
    20261003T221500123Z-9f3a61c0/      ← the backup's id
      0.age                            ← entry 0: zstd, then age
      1.age                            ← entry 1
      …
      catalog.age                      ← the entry names and digests: zstd, then age
      manifest.sig                     ← with `signing`: 64 bytes, just before the manifest
      manifest.json                    ← in the clear, written last
    20261004T221500087Z-03be44d1/      ← an incremental: only what changed since its parent
      0.age                            ← the first entry it stores itself
      catalog.age                      ← every entry of its view, stored here or pointed to
      manifest.json
  database/                            ← another definition, same repository
    …
```

A key is `<backup>/<id>/<object>`, `/`-separated, and a repository stores
the bytes under it as they are. In an `s3Repository` the same keys sit
under its `prefix` — `nightly/uploads/<id>/manifest.json` with
`prefix: 'nightly'` — and opening one by hand starts with your store's own
tool (`aws s3 cp`, say) where a local folder needs none. Several definitions share a repository
without meeting, since each lives under its own name.

## Locks

`<backup>/locks/` holds one small JSON file per `create`, `prune`, `hold` or
`unhold` running against that repository — written at its start, rewritten
every third of the lease, deleted at its end. `operation` is `create`, or
`prune` — which `hold` and `unhold` record too, so that a 0.4 reader, which
knows only those two, reads their lock and lets it expire:

```json
{"format":"nxgt-backup-lock/1","id":"20261004T221500123Z-1a2b3c4d","operation":"create","expiresAt":"2026-10-04T22:20:00.123Z"}
```

Its `id` is the lock's own, not a backup's. The folder holds no manifest, so
`list` never takes it for a backup, and it is empty whenever nothing runs —
unless a run was killed, or a file there does not parse.
[Locking](locking.md) has the protocol, the lease, and clearing one by hand.

## Holds

`<backup>/holds/` holds one small JSON file per backup under a legal hold,
named after the backup's id — put by `hold`, deleted by `unhold`, in each
repository they act in:

```json
{"format":"nxgt-backup-hold/1","id":"20260611T221500342Z-77ac1e09","heldAt":"2026-10-04T09:12:44.501Z"}
```

`list` and `prune` read the **keys** alone: a file
`<backup>/holds/<id>.json` is a hold, whatever it holds. A hold is per
repository, and `prune` never removes one — [rotation](rotation.md#legal-holds).

## Objects

The *n*-th entry a backup stores itself — counting from 0, in the order the
source gave them — is `<n>.age`: its bytes compressed with zstd, then
encrypted with age to every recipient. In a full backup that is every entry;
an [incremental or differential](chains.md) one numbers only the entries it
stores, and an entry it points to keeps the key it has in the backup that
stored it. The object's name is a number: an entry's own name never appears
in a key, a file name or anything else in the clear.

## The catalog

`catalog.age` is a JSON document, compressed and encrypted like the entries.
It is what ties an object back to the entry it holds:

```json
{
	"format": "nxgt-backup-catalog/1",
	"source": { "kind": "directory" },
	"entries": [
		{ "name": "a.txt", "object": "0.age", "size": 5, "sha256": "8ed3f6ad…", "fingerprint": "5:1791158100123456789:1791158100123456789:48213377" },
		{ "name": "d/b.txt", "object": "1.age", "size": 4, "sha256": "f44e64e7…", "fingerprint": "4:1791158100223456789:1791158100223456789:48213378" }
	]
}
```

The catalog of an incremental built on that backup, where `a.txt` changed
and `d/b.txt` did not: `a.txt` is its own `0.age`, and `d/b.txt` points to
the object of the backup that stored it:

```json
{
	"format": "nxgt-backup-catalog/1",
	"source": { "kind": "directory" },
	"entries": [
		{ "name": "a.txt", "object": "0.age", "size": 6, "sha256": "2c26b46b…", "fingerprint": "6:1791244500123456789:1791244500123456789:48213390" },
		{ "name": "d/b.txt", "object": "1.age", "in": "20261003T221500123Z-9f3a61c0", "size": 4, "sha256": "f44e64e7…", "fingerprint": "4:1791158100223456789:1791158100223456789:48213378" }
	]
}
```

A source that keeps a position — a change feed's cursor — adds it last:
`"position": "c-1042"`.

| Field | |
| --- | --- |
| `source.kind` | what the source said it was: `directory`, or your own source's `kind` |
| `entries` | **every entry the backup restores** — its whole view — whether stored in it or in an older backup of its chain |
| `entries[].name` | the name the source gave: a relative path, a collection's name. Not empty, at most 4096 characters, no NUL, unique within the backup |
| `entries[].object` | the object holding it, in the backup that holds it. The entries this backup stores itself are `0.age`, `1.age`, … in order, as many as its manifest lists |
| `entries[].in` | only on an entry stored elsewhere: the id of the older backup of its chain that **stored** it — never an intermediate one, so there is no second hop |
| `entries[].size`, `entries[].sha256` | the **plain** bytes, as the source gave them, before compression |
| `entries[].fingerprint` | what the source said of it without reading it, if it said anything — at most 1024 bytes in UTF-8. `directorySource` gives `size:mtimeNs:ctimeNs:ino`, or none for a file changed within two seconds of the read — [chains](chains.md#the-folders-fingerprint) |
| `position` | where the source stood once every entry was read — a cursor, a resume token — if it gave one; at most 64 KiB in UTF-8. Handed back to the next backup built on this one — [chains](chains.md#writing-a-source-with-fingerprints-and-a-position) |

A fingerprint and a position are encrypted with the rest of the catalog:
a file's times and a feed's cursor say something too.

The names are in the catalog, not the manifest, because names say a lot —
`customers-2026-export.csv` — and a repository should hold none of them in
the clear. The package's own spec checks that neither a name nor a byte of
content can be found in any file of the repository.

## The manifest

`manifest.json` is the one file in the clear, and it is written **last**:

```json
{
	"format": "nxgt-backup/1",
	"backup": "uploads",
	"id": "20261003T221500123Z-9f3a61c0",
	"createdAt": "2026-10-03T22:15:00.123Z",
	"kind": "full",
	"parent": null,
	"recipients": ["age1…"],
	"compression": "zstd",
	"catalog": { "key": "catalog.age", "size": 1890, "sha256": "c4fbeb79…" },
	"objects": [
		{ "key": "0.age", "size": 1673, "sha256": "79eef98a…" },
		{ "key": "1.age", "size": 1672, "sha256": "5b58eff6…" }
	]
}
```

| Field | |
| --- | --- |
| `format` | `nxgt-backup/1`. A manifest of a later format is refused, not guessed at |
| `backup`, `id` | which backup it describes. A manifest under another backup's folder is refused |
| `createdAt` | when the backup started, as an ISO date |
| `kind` | `full`, `incremental` or `differential` — [chains](chains.md#full-incremental-differential) |
| `parent` | `null` for a full backup; otherwise the id of the backup it builds on, which must be **older** than its own `id` — so walking a chain always ends. One that does not fit its kind is refused. `prune` keeps a kept backup's parent — [rotation](rotation.md#chains) |
| `recipients` | the public keys it is encrypted to — public, so harmless in the clear, and useful to know which key opens it |
| `compression` | `zstd` |
| `catalog`, `objects` | every object's key, its size **encrypted**, and the SHA-256 of its encrypted bytes |

It names no entry, so everything that needs only the manifest needs **no
key**: `list`, `verify` without identities, and [`prune`](rotation.md). Its
`objects` are only those the backup stores itself: what an incremental
points to is pinned by the manifest of the backup that stored it.

**A backup exists once its manifest does.** Every object goes first, then the
catalog, then — with `signing` — the signature, then the manifest, so a
backup that stopped half-way — the process killed, the disk full, a source that threw, a lock lease that ran out — has no manifest: `list` leaves it out, and
`verify` and `restore` answer `NOT_FOUND`. With several
repositories, the manifest goes only into those that took every object before
it — [repositories](repositories.md#several-repositories). `prune` removes
such leftovers once they are old enough —
[incomplete backups](rotation.md#incomplete-backups) — and, removing a
backup, deletes its manifest first, so it stops existing before any of its
objects goes.

**The manifest is untrusted input.** A repository is not trusted: a
manifest is read field by field, only the known fields are kept, and one
that does not parse, names another backup or id, lists objects out of
order, or has a `parent` that does not fit its kind is `INTEGRITY` — or, in `list`, an id in `unreadable`.
[Troubleshooting](../troubleshooting.md#verify-on-app-the-manifest-is-unreadable--repository-local)
lists each reason.

## The signature

With `signing` given to `bindBackup`, `manifest.sig` holds the 64 raw bytes
of an Ed25519 signature over the **exact bytes** of `manifest.json` — no
encoding, no header. It is put just before the manifest, in every
repository, so a manifest never stands without it; a signature with no
manifest beside it is a run that stopped, not a backup.

A reader with `trusted` keys checks it on the manifest's bytes before
parsing them, reads no more than 65 bytes of it, and refuses a backup
without one, or with one no trusted key made, with `SIGNATURE`. Without
`signing`, no `manifest.sig` is written; without `trusted`, none is read —
[signing](signing.md).

A manifest is read no further than 64 MiB — about half a million entries at
some 130 bytes each — whether signed or not: a larger one is `INTEGRITY`,
and `create` refuses to write one, since it could not be read back.

## Ids

An id is the backup's UTC start time to the millisecond, then 8 random hex
digits:

```text
20261003T221500123Z-9f3a61c0
yyyymmddThhmmssmmmZ-random
```

Ids sort as their times do, so a repository's listing is already in order and
`list` gives the oldest first; two runs started in the same millisecond still
differ. `verify` and `restore` refuse anything else with a `TypeError` before
they read a byte:

```ts
await backups.verify('latest');
// TypeError: verify on "uploads": the id is not a backup id
```

## Opening a backup by hand

The format is age's and zstd's on purpose: a backup must open on the day this
package is not at hand. With the [`age`](https://github.com/FiloSottile/age)
and `zstd` commands and the secret key in `key.txt`:

```sh
cd /mnt/backups/uploads/20261003T221500123Z-9f3a61c0

# which entry is in which object
age -d -i key.txt catalog.age | zstd -d

# one entry
age -d -i key.txt 0.age | zstd -d > a.txt

# check it against the manifest first, as restore does
sha256sum 0.age    # the manifest's objects[0].sha256

# an entry an incremental points to: its "object", in the folder its "in" names
age -d -i key.txt ../20261003T221500123Z-9f3a61c0/1.age | zstd -d > b.txt

# and the manifest against its signature — OpenSSL 3, not macOS's LibreSSL
openssl pkeyutl -verify -pubin -inkey signing.pub.pem -rawin \
  -in manifest.json -sigfile manifest.sig
```

The `age` and `zstd` commands were not run for this page — no `age` or `zstd`
binary was at hand. What was run: a backup made by this package, its
`0.age` and `catalog.age` opened with the `age-encryption` library's plain
`Decrypter` and `Bun.zstdDecompressSync`, with no code from this package,
gave back the entry and the catalog above. Both are the standard formats the
commands read. A hybrid post-quantum key (`age1pq1…`) needs an `age` release
that knows that key type. The `openssl` line was run, with OpenSSL 3.5.9:
[checking a signature by hand](signing.md#checking-a-signature-by-hand).

Next: [encryption](encryption.md), for the keys and what each check proves.
