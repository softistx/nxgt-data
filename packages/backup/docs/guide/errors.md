# Errors

This page covers what each call can fail with — `BackupError` and its codes,
the bare `TypeError`s of wiring, and errors that pass through — and how to
handle them.

```ts
import { BackupError } from '@nxgt/backup';

try {
	await backups.restore(id, target, { identities: [identity] });
} catch (error) {
	if (error instanceof BackupError) {
		console.error(error.code, error.backup, error.id, error.repository);
	}
	throw error;
}
```

## `BackupError`

The one error this package throws of its own. It extends `Error`.

```ts
class BackupError extends Error {
	name: string;                             // 'BackupError'
	readonly code: BackupErrorCode;
	readonly backup: string;                  // the definition's name
	readonly id: string | undefined;          // the backup's id, once there is one
	readonly repository: string | undefined;  // for NOT_FOUND, INTEGRITY, DECRYPT, SIGNATURE
	readonly outcomes: readonly RepositoryOutcome[]; // for PARTIAL and NOT_STORED; [] otherwise
	readonly cause?: unknown;                 // age's or zstd's error, where there is one
}

type BackupErrorCode =
	| 'NOT_FOUND'
	| 'INTEGRITY'
	| 'DECRYPT'
	| 'SIGNATURE'
	| 'PARTIAL'
	| 'NOT_STORED';

type RepositoryOutcome =
	| { repository: string; stored: true }
	| { repository: string; stored: false; error: unknown };
```

The message names the call you made, the definition and the repository —
`restore on "uploads": … (repository "nas")` — and **never** a key, an
entry's name, nor anything read from a source or a repository. It is safe to
log.

| Code | Thrown by | Means | Fields |
| --- | --- | --- | --- |
| `NOT_FOUND` | `verify`, `restore` | no backup with that id in that repository — or one whose manifest was never written, which is the same thing. From `restore`, also a name in `only` that the backup does not hold | `id`, `repository` |
| `INTEGRITY` | `verify`, `restore` | what the repository holds is not what was written: an object missing, or differing in size or SHA-256 from the manifest; a manifest or catalog that does not read; an entry whose plain bytes differ from the catalog. A mismatch against the manifest stops before a byte is decrypted; a mismatch against the catalog fails the entry's stream at its end, so a target that stages, like `directoryTarget`, lands nothing, while one that streams has already seen the bytes | `id`, `repository`, and `cause` when age or zstd refused the bytes |
| `DECRYPT` | `verify` with identities, `restore` | none of the identities given opens the backup. The object matched its manifest, so the bytes are fine; the key is not | `id`, `repository`, `cause` (age's error) |
| `SIGNATURE` | `verify`, `restore` | `trusted` keys are set — given, or derived from `signing` — and the manifest has no `manifest.sig` (`the manifest is not signed`), or one none of them made (`no trusted key signed the manifest`). Checked on the manifest's bytes before they are parsed: nothing else of the backup was read, and nothing reached the target — [signing](signing.md) | `id`, `repository` |
| `PARTIAL` | `create` | stored in some repositories and not others. The stored copies are complete | `id`, `outcomes` |
| `NOT_STORED` | `create` | stored nowhere | `id`, `outcomes`, each with its error |

`list` throws none of them for a bad manifest: an id whose manifest does not
read, or — with `trusted` keys — is not signed by one of them, goes into
`unreadable` instead, and `verify` on it gives the `INTEGRITY` or the
`SIGNATURE` with its reason.

Every message, with what causes it and what to do, is in
[troubleshooting](../troubleshooting.md).

## Bare `TypeError`s

A refusal that comes from the code, not from what a repository holds, is a
plain `TypeError` with no code: no handler should answer it, and it shows
up the first time the code runs.

| Thrown by | When |
| --- | --- |
| `defineBackup` | a name that could not be a path segment |
| `bindBackup` | a definition not from `defineBackup`, no repository, two repositories with one name, no recipient or one age refuses, a relative `tmpDir`; a `signing.key` that is not an Ed25519 private key, a `trusted` list that is empty, holds a private key or a key that is not an Ed25519 public key, or leaves out `signing.key`'s public half — [signing](signing.md#checked-at-bind-time). These never quote the key and carry no `cause` |
| `localRepository`, `directorySource`, `directoryTarget` | a relative `path` |
| `list`, `verify`, `restore` | a `from` that names no repository given to `bindBackup` |
| `verify`, `restore` | an id that is not a backup id; no identity, or one age refuses |
| `restore` | a target whose `write` resolved before its stream ended: nothing it was given was checked |
| `create` | an entry name your source gave that is empty, over 4096 characters, holds a NUL, or was given twice |
| `directoryTarget`, during `restore` | an entry name that is not a relative path inside the folder, or whose folder is a link or a file there; a file already there without `overwrite` |

The calls are `async`: a `TypeError` from `list`, `verify`, `restore` or
`create` is a rejection, not a synchronous throw.

## What passes through

Errors this package did not raise come back as they are:

- from **your source** — `create` rejects with what it threw or its stream
  errored with, and the backup gets no manifest;
- from **your target** — `restore` rejects with it, and stops;
- from **a repository's `get` or `list`** — `list`, `verify` and `restore`
  reject with it. A failed `put` is caught, and lands in `outcomes`;
- from **the file system**, for `tmpDir` — `ENOSPC` when there is no room
  for an object, `EACCES` when it cannot be written.

File system errors carry a `code` of their own — `ENOENT`, `ENOSPC` — so
**test `instanceof BackupError` before reading `code`**.

## A handler

A scheduled job that sorts every failure into something to retry, something
to look at, and a bug:

```ts
import { BackupError } from '@nxgt/backup';

type Verdict = 'ok' | 'degraded' | 'retry' | 'alert' | 'bug';

export function verdictOf(error: unknown): Verdict {
	if (error instanceof BackupError) {
		switch (error.code) {
			case 'PARTIAL':
				return 'degraded'; // the backup exists somewhere; fix the repository that failed
			case 'NOT_STORED':
				return 'retry'; // nowhere took it: a mount, the network, a full disk
			case 'INTEGRITY':
				return 'alert'; // a repository holds what was not written: damage, or tampering
			case 'DECRYPT':
				return 'alert'; // the wrong key, or a backup encrypted to a key you no longer have
			case 'NOT_FOUND':
				return 'alert'; // the backup is gone, or never finished
			case 'SIGNATURE':
				return 'alert'; // not written by a key you trust: forged, edited, or signed by a retired key
		}
	}
	if (error instanceof TypeError) return 'bug'; // wiring: fix the code
	return 'retry'; // a source, a target, a repository, or the file system
}

export async function nightly(run: () => Promise<unknown>): Promise<Verdict> {
	try {
		await run();
		return 'ok';
	} catch (error) {
		const verdict = verdictOf(error);
		console.error(verdict, error instanceof Error ? error.message : error);
		return verdict;
	}
}
```

`BackupError` extends `Error`, not `TypeError`, so the order of those two
tests does not matter here; the order against a check on `code` alone does.

Next: [troubleshooting](../troubleshooting.md), by message.
