# @nxgt/mongo-kit

## 0.3.0

### Minor Changes

- [#87](https://github.com/softistx/nxgt-data/pull/87) [`01063a5`](https://github.com/softistx/nxgt-data/commit/01063a51728a7ff1b0a24281842d2e7d8bd1ea2c) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `kit.ping(options?)` sends `ping` to every database the kit wires, at once, and reports `@nxgt/mongo`'s `PingResult` under each database's name — `{ ok: true, latencyMs }` or `{ ok: false, error }` — for a health endpoint. It never throws and answers within `timeoutMS` (2 s by default) even for a `client` the configuration handed over unconnected, whose first connect the driver bounds by `serverSelectionTimeoutMS` instead. Every kit answers, derived ones included.

## 0.2.1

### Patch Changes

- Updated dependencies [[`1f99fcb`](https://github.com/softistx/nxgt-data/commit/1f99fcb8bbf37e6af9cc19a0b919c9c7d6a9a893), [`1f99fcb`](https://github.com/softistx/nxgt-data/commit/1f99fcb8bbf37e6af9cc19a0b919c9c7d6a9a893)]:
  - @nxgt/mongo@0.17.0

## 0.2.0

### Minor Changes

- [#68](https://github.com/softistx/nxgt-data/pull/68) [`2e63c80`](https://github.com/softistx/nxgt-data/commit/2e63c80a3530fb5cc600c2deb2ddc1d1b68bfd19) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Every refusal this package makes is a `KitError`, with a code to switch on.
  
  ```ts
  import { KitError } from '@nxgt/mongo-kit';
  
  try {
  	await createKit(config);
  } catch (error) {
  	if (error instanceof KitError && error.code === 'COLLISION') {
  		// `error.database` and `error.key` name where, without parsing the text.
  	}
  }
  ```
  
  `code` is one of `CONFIG`, `COLLISION`, `NO_DATABASE`, `SEVERAL_DATABASES`,
  `TRANSACTION`, `DERIVED` or `DISCOVERY`; `database` and `key` carry which
  database and which collection key it is about. Until now every one of these
  was a bare `TypeError` with the answer only in the sentence, so a caller that
  wanted to tell a configuration collision from a missing database had to match
  message text.
  
  **It extends `TypeError`, not `Error`**, because that is exactly what these
  were before it existed: a `catch` that already tests `error instanceof
  TypeError` keeps catching them, and gains a `code` it can read. The class,
  `KitErrorCode` and `KitErrorOptions` are exported.
  
  Two messages say more than they did. A `databases` block that is not one now
  names the shape — `{ databases: { main: … } }` — and says a single database
  is the configuration itself, naming itself with `database`; it used to state
  only that the value was wrong. An empty one now says to give it at least one,
  with the same shape.

### Patch Changes

- Updated dependencies [[`2e63c80`](https://github.com/softistx/nxgt-data/commit/2e63c80a3530fb5cc600c2deb2ddc1d1b68bfd19)]:
  - @nxgt/mongo@0.16.0

## 0.1.5

### Patch Changes

- [#66](https://github.com/softistx/nxgt-data/pull/66) [`5c5aa1d`](https://github.com/softistx/nxgt-data/commit/5c5aa1d8b8902c25e9a6a8a12b1ce44834c943f6) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Every package now ships a `docs/` folder, linked from its npm page.
  
  The README stays the short version: what the package is, how to install it,
  and one copy-paste example per area. `docs/` is the long one — a guide page
  per area with the option tables, the defaults, what is returned and what is
  thrown; a `troubleshooting.md` whose headings are the exact error text you
  would paste into a search box, with the line that prevents each one; and a
  `roadmap.md` saying what is coming, and what is deliberately not.
  
  `docs` is named in each package's `files`, so it travels in the tarball
  rather than living only on GitHub.
- Updated dependencies [[`5c5aa1d`](https://github.com/softistx/nxgt-data/commit/5c5aa1d8b8902c25e9a6a8a12b1ce44834c943f6)]:
  - @nxgt/mongo@0.15.1

## 0.1.4

### Patch Changes

- Updated dependencies [[`b4f07aa`](https://github.com/softistx/nxgt-data/commit/b4f07aa4c497bec08297a0c4bd9cb0ea57ccc682)]:
  - @nxgt/mongo@0.15.0

## 0.1.3

### Patch Changes

- Updated dependencies [[`a6cac9b`](https://github.com/softistx/nxgt-data/commit/a6cac9bf5f22c44c9b6e1b211ae8946e4658cad3)]:
  - @nxgt/mongo@0.14.0

## 0.1.2

### Patch Changes

- Updated dependencies [[`9117fff`](https://github.com/softistx/nxgt-data/commit/9117fffc1897452d1503c814fc878dbd8082286e)]:
  - @nxgt/mongo@0.13.0

## 0.1.1

### Patch Changes

- Updated dependencies [[`5012472`](https://github.com/softistx/nxgt-data/commit/5012472fdcbb374961b2d604303c9f732da69114)]:
  - @nxgt/mongo@0.12.0

## 0.1.0

### Minor Changes

- [#37](https://github.com/softistx/nxgt-data/pull/37) [`24bd4e7`](https://github.com/softistx/nxgt-data/commit/24bd4e7e3de1fa265f01df857730baba11f934fe) Thanks [@SteveGT96](https://github.com/SteveGT96)! - First release: an application's MongoDB wiring in one object.
  
  `defineConfig` checks a configuration — one database or several, a `uri` or a
  client the application opened, the collections as `import * as collections`,
  and the collection options — and freezes it, connecting to nothing.
  `createKit` opens it and gives a kit whose `db` is the driver's own `Db` with
  every collection typed on it, so `db.users` is the typed collection and
  `db.command(…)` is still the driver's.
  
  It carries what used to be threaded by hand: `as(actor)` and
  `withSession(session)` give another kit over the same clients,
  `transaction(fn)` runs the body with a kit whose collections are all in the
  session and joins an outer transaction rather than opening a second one,
  `sync()` syncs exactly the collections the kit wires, database by database,
  and `close()` gives back the clients it opened and leaves alone the ones it
  was given. A collection wired under a name the driver's `Db` already has is
  refused, by the types and again against the object itself.
  
  `discoverCollections({ glob })` reads definitions from the file system for
  scripts; it has no types and does not survive bundling.
