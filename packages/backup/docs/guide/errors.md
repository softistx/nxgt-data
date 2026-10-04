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
	readonly repository: string | undefined;  // for NOT_FOUND, INTEGRITY, DECRYPT, SIGNATURE, LOCKED, LEASE_LOST
	readonly outcomes: readonly RepositoryOutcome[]; // for PARTIAL and NOT_STORED; [] otherwise
	readonly cause?: unknown;                 // age's or zstd's error, where there is one
}

type BackupErrorCode =
	| 'NOT_FOUND'
	| 'INTEGRITY'
	| 'DECRYPT'
	| 'SIGNATURE'
	| 'PARTIAL'
	| 'NOT_STORED'
	| 'LOCKED'
	| 'LEASE_LOST';

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
| `NOT_FOUND` | `verify`, `restore`, `hold`, `create` | no backup with that id in that repository — or one whose manifest was never written, which is the same thing. From `restore`, also a name in `only` that the backup does not hold. From `hold`, no repository asked has the backup: `hold on "uploads": no repository holds that backup`. From an incremental or differential `create`, nothing to build on in `from` — `create on "uploads": no backup to build on` (`no full backup to build on` for a differential) — as its rejection, before the source is read; or, as one repository's `outcomes[].error` inside `PARTIAL`, a repository that lacks the backup it builds on: `the backup it builds on is not in this repository` — [chains](chains.md) | `id`, `repository` (not from `hold`) |
| `INTEGRITY` | `verify`, `restore`, `hold`, `create` | what the repository holds is not what was written: an object missing, or differing in size or SHA-256 from the manifest; a manifest or catalog that does not read; an entry whose plain bytes differ from the catalog; a backup an incremental builds on that is gone (`a backup it builds on is missing`), or a catalog pointing outside its chain — `id` is then the backup holding the object at fault, which may be an older one of the chain. From `create`, the backup an incremental builds on has a broken chain or a catalog that does not read — in another repository than `from`, as that repository's outcome inside `PARTIAL`. A mismatch against the manifest stops before a byte is decrypted; a mismatch against the catalog fails the entry's stream at its end, so a target that stages, like `directoryTarget`, lands nothing, while one that streams has already seen the bytes | `id`, `repository`, and `cause` when age or zstd refused the bytes |
| `DECRYPT` | `verify` with identities, `restore`, an incremental or differential `create` | none of the identities given opens the backup — for `create`, the one it builds on. The object matched its manifest, so the bytes are fine; the key is not | `id`, `repository`, `cause` (age's error) |
| `SIGNATURE` | `verify`, `restore`, `hold`; an incremental or differential `create` (a rejection for `from`, an outcome elsewhere) | `trusted` keys are set — given, or derived from `signing` — and the manifest has no `manifest.sig` (`the manifest is not signed`), or one none of them made (`no trusted key signed the manifest`) — for an incremental or differential, the manifest of any backup of its chain, and `id` is then that backup's. Checked on the manifest's bytes before they are parsed: nothing else of the backup was read, and nothing reached the target — [signing](signing.md) | `id`, `repository` |
| `PARTIAL` | `create` | stored in some repositories and not others. The stored copies are complete | `id`, `outcomes` |
| `NOT_STORED` | `create` | stored nowhere | `id`, `outcomes`, each with its error |
| `LOCKED` | `create`, as one repository's `outcomes[].error` — as its rejection only for an incremental or differential whose named `from` could not be locked; `prune`, `hold` and `unhold`, as their rejection | another `create`, `prune` or `hold` of the same definition has that repository's lock: `another create, prune or hold has the lock`. Nothing was written or removed there; a `hold` or `unhold` keeps what it did in the repositories before. For `create`, the other repositories go on, and when every one is `LOCKED` the source is never opened. Retry later — [locking](locking.md) | `repository` |
| `LEASE_LOST` | `create`, as one repository's `outcomes[].error` — never as its rejection; `prune`, `hold` and `unhold`, as their rejection | this run held that repository's lock and could not renew it in time — the store out of reach for the lock's writes, or the process paused longer than the lease: `the lock's lease ran out before it was done`. It started nothing more there. For `create`, that repository has no manifest for the id, a `put` already under way may still have landed, and the other repositories go on; for `prune`, what was removed is gone and the rest stays — [rotation](rotation.md#the-lock-and-lease_lost). Worth an alert, not just a retry — [locking](locking.md#when-it-refuses-and-when-its-lease-runs-out) | `id` (for `prune`, the backup it was removing), `repository` |

`list` throws none of them for a bad manifest: an id whose manifest does not
read, or — with `trusted` keys — is not signed by one of them, goes into
`unreadable` instead, and `verify` on it gives the `INTEGRITY` or the
`SIGNATURE` with its reason. A backup removed between `list`'s listing and
its read of the manifest is skipped silently — neither in `backups` nor in
`unreadable`, and no error.

Every message, with what causes it and what to do, is in
[troubleshooting](../troubleshooting.md).

## Bare `TypeError`s

A refusal that comes from the code, not from what a repository holds, is a
plain `TypeError` with no code: no handler should answer it, and it shows
up the first time the code runs.

| Thrown by | When |
| --- | --- |
| `defineBackup` | a name that could not be a path segment |
| `bindBackup` | a definition not from `defineBackup`, no repository, two repositories with one name, no recipient or one age refuses, a relative `tmpDir`; a `lock.lease` that is not a whole number of milliseconds from 1 second to 1 day (`bindBackup: lock.lease must be a whole number of milliseconds, from 1 second to 1 day`); a `signing.key` that is not an Ed25519 private key, a `trusted` list that is empty, holds a private key or a key that is not an Ed25519 public key, or leaves out `signing.key`'s public half — [signing](signing.md#checked-at-bind-time). These never quote the key and carry no `cause` |
| `localRepository`, `directorySource`, `directoryTarget` | a relative `path` |
| `s3Repository` | a `prefix` that is not a relative path of plain segments; a `partSize` under 5 MiB or not an integer. Neither quotes what was given |
| an `s3Repository`'s `get`, `put`, `delete`, `list` | a key (or a `list` prefix, less its trailing `/`) that is not a relative path of plain segments — only when you call the repository yourself, since the package builds its keys |
| `list`, `verify`, `restore`, `prune`, `hold`, `unhold` | a `from` that names no repository given to `bindBackup` |
| `verify`, `restore`, `hold`, `unhold` | an id that is not a backup id |
| `verify`, `restore`, an incremental or differential `create` | no identity, or one age refuses |
| `create` | a `kind` that is not `full`, `incremental` or `differential` (`create on "uploads": kind must be full, incremental or differential`); a `from` that names no repository; a source whose `kind` is not the one the backup it builds on was made from (`create on "uploads": the source is not of the kind the backup it builds on was made from`); a backup to build on encrypted to other recipients than the binding's (`create on "uploads": the backup it builds on is encrypted to other recipients; make a full backup first`) — [chains](chains.md#errors) |
| `prune` | a `keep` that names no rule (`prune on "uploads": keep must name at least one rule`), or a rule that is not a whole number, 1 or more (`prune on "uploads": keep.daily must be a whole number, 1 or more`); an `incompleteAfter` that is not a whole number of milliseconds, or is under two lock leases (`prune on "uploads": incompleteAfter must be a whole number of milliseconds, two lock leases at least`); a `now` that is not a valid `Date` (`prune on "uploads": now must be a valid Date`) — [rotation](rotation.md#errors) |
| `restore` | a target whose `write` resolved before its stream ended: nothing it was given was checked |
| `create` | an entry name your source gave that is empty, over 4096 characters, holds a NUL, or was given twice; a `fingerprint` that is not a string of at most 1024 bytes; a `position()` that is not a string of at most 64 KiB |
| `directoryTarget`, during `restore` | an entry name that is not a relative path inside the folder, or whose folder is a link or a file there; a file already there without `overwrite` |

The calls are `async`: a `TypeError` from `list`, `verify`, `restore`,
`create`, `prune`, `hold` or `unhold` is a rejection, not a synchronous
throw.

## What passes through

Errors this package did not raise come back as they are:

- from **your source** — `create` rejects with what it threw or its stream
  errored with, and the backup gets no manifest;
- from **your target** — `restore` rejects with it, and stops;
- from **a repository's `get`, `list` or `delete`** — `list`, `verify`,
  `restore`, `prune`, `hold` and `unhold` reject with it (`prune` releases its
  lock first): for `s3Repository`, Bun's `S3Error`, such as
  `AccessDenied`, or `s3 repository: a listing page was cut short with no way
  to go on` when the store pages without a token. A failed `put` is caught, and lands in `outcomes` — for
  `s3Repository`, an `S3Error` or `s3 repository: an object was not stored
  whole` — [repositories](repositories.md#how-it-writes);
- from **the file system**, for `tmpDir` — `ENOSPC` when there is no room
  for an object, `EACCES` when it cannot be written.

File system errors carry a `code` of their own — `ENOENT`, `ENOSPC` — so
**test `instanceof BackupError` before reading `code`**.

## A handler

A scheduled job that sorts every failure into something to retry, something
to look at, and a bug:

```ts
import { BackupError } from '@nxgt/backup';

type Verdict = 'ok' | 'skipped' | 'degraded' | 'retry' | 'alert' | 'bug';

/** Every repository refused because another run of the definition has its lock. */
function allLocked(error: BackupError): boolean {
	return error.outcomes.every(
		(outcome) =>
			!outcome.stored &&
			outcome.error instanceof BackupError &&
			outcome.error.code === 'LOCKED',
	);
}

/** Some repository lost this run's own lock part-way: the store or the host needs a look. */
function leaseLost(error: BackupError): boolean {
	return error.outcomes.some(
		(outcome) =>
			!outcome.stored &&
			outcome.error instanceof BackupError &&
			outcome.error.code === 'LEASE_LOST',
	);
}

export function verdictOf(error: unknown): Verdict {
	if (error instanceof BackupError) {
		switch (error.code) {
			case 'PARTIAL':
				return leaseLost(error) ? 'alert' : 'degraded'; // the backup exists somewhere; fix the repository that failed
			case 'NOT_STORED':
				if (allLocked(error)) return 'skipped'; // another run holds every lock
				if (leaseLost(error)) return 'alert'; // a store dropped out for a whole lease, or the process stalled
				return 'retry'; // nowhere took it: a mount, the network, a full disk
			case 'LOCKED':
				return 'skipped'; // a prune or a hold refused: another run has the lock
			case 'LEASE_LOST':
				return 'alert'; // a prune stopped part-way: the store or the host needs a look
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
