# @nxgt/mongo-kit

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
