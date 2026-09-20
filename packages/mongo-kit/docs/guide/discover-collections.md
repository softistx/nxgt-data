# `discoverCollections`

Reads the collection definitions a glob matches, for a **script** that has no
kit to work from — a sync, a migration, a one-off run from the repository.

```ts
import { connectMongo, syncCollections } from '@nxgt/mongo';
import { discoverCollections } from '@nxgt/mongo-kit';

const mongo = await connectMongo(process.env.MONGO_URI!);
const definitions = await discoverCollections({ glob: 'src/**/*.model.ts' });
await syncCollections(mongo.db, definitions);
await mongo.close();
```

It gives `@nxgt/mongo`'s `AnyCollectionDefinition[]`, sorted by path and with
each definition appearing once.

## It is for scripts, and for nothing else

- **It produces no types.** A glob is read at run time, so the compiler sees
  nothing: everything it returns is an `AnyCollectionDefinition`.
- **It does not survive bundling.** A bundler cannot follow a glob, so the
  matched files are not in the bundle and nothing is found.
- **It needs the Bun runtime**: the glob is `Bun.Glob`. A Node script gets
  `ReferenceError: Bun is not defined`.
- **It imports every file it matches**, so their top level runs — and a model
  file's top level registers its definition.

An application wires its collections with
`import * as collections from './models'`, which a bundler follows and the
compiler sees. See [Configuration](configuration.md).

## Options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `glob` | `string` | — | Relative to `cwd`: `'src/models/*.model.ts'`. Required |
| `cwd` | `string` | `process.cwd()` | Where the glob starts |
| `export` | `string` | — | Read one export by name in each file. Without it, every export that is a definition is taken |

```ts
// every definition each file exports
await discoverCollections({ glob: 'test/models/*.model.ts', cwd });

// only the export called `definition`, in each matched file
await discoverCollections({
	glob: 'test/models/*.model.ts',
	cwd,
	export: 'definition',
});
```

A glob that matches nothing gives `[]`.

## What it throws

All three are a [`KitError`](errors.md) with `code: 'DISCOVERY'`. The two
that are about a file carry its path on `key`; the missing-glob one has no
path yet, so its `key` is `undefined`:

- `discoverCollections: a glob is required` — `glob` missing or empty.
- `discoverCollections: <path> exports no definition named "<name>"` — with
  `export`, a matched file that has no definition under that name. Without
  `export`, such a file simply contributes nothing.
- `discoverCollections: <a> and <b> both define the collection "<name>"` —
  two files describing one server collection.

## Signatures

```ts
interface DiscoverOptions {
	glob: string;
	cwd?: string;
	export?: string;
}

function discoverCollections(
	options: DiscoverOptions,
): Promise<AnyCollectionDefinition[]>;
```

## Next

- [Syncing](sync.md) — the same step for an application that has a kit.
