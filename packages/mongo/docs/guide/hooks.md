# Hooks

Hooks run around this package's writes, typed by the collection's schema: a
field filled before every create, an audit line after every delete, a tenant
added to every filter.

```ts
import { getCollection } from '@nxgt/mongo';
import { users } from './collections';

const collection = getCollection(db, users, {
	hooks: {
		beforeCreate: ({ values }) => ({
			values: { ...values, email: values.email.toLowerCase() },
		}),
		afterDelete: async (user, { hard, actor, session, collection }) => {
			await collection.db
				.collection('audit')
				.insertOne({ user: user._id, hard, actor }, { session });
		},
	},
});

await collection.create({ email: 'ADA@EXAMPLE.COM' });   // stored lowercased
```

Reads run no hooks, and neither do the driver's own methods or `raw`.

## What runs around what

| Hooks | Around | `before` gets and may return | `after` gets |
| --- | --- | --- | --- |
| `beforeCreate`, `afterCreate` | `create`, each document of `createMany`, and an `upsert` that inserted | `{ values }` | the document |
| `beforeUpdate`, `afterUpdate` | `update`, and an `upsert` that matched | `{ id, patch }` | the document |
| `beforeUpdateMany`, `afterUpdateMany` | `updateMany` | `{ filter, patch }` | the count |
| `beforeDelete`, `afterDelete` | `delete`, `hardDelete` | `{ id }` | the document |
| `beforeDeleteMany`, `afterDeleteMany` | `deleteMany`, `hardDeleteMany` | `{ filter }` | the count |
| `beforeRestore`, `afterRestore` | `restore`, where the collection soft deletes | `{ id }` | the document |
| `beforeUpsert` | `upsert` | `{ filter, values }` | — |

`createMany` runs the create hooks once per document, so a rule written for
one document holds for a batch.

## A `before` hook replaces what is written

Returning a value of the same shape replaces it; returning nothing keeps it;
throwing stops the write.

```ts
const scoped = getCollection(db, posts, {
	hooks: {
		// Every read and write of this collection stays inside one tenant.
		beforeUpdateMany: ({ filter, patch }) => ({
			filter: { $and: [filter, { teamId }] },
			patch,
		}),
		beforeDelete: ({ id }) => {
			if (!allowed(id)) throw new Error('not yours');
		},
	},
});
```

A filter is checked **before** the hooks run, so `deleteMany({})` is refused
even when a hook would have narrowed it — and no hook runs for it.

## An `after` hook gets the result, and the arguments

The second parameter is the context with the write's own arguments spread
into it.

```ts
const collection = getCollection(db, users, {
	hooks: {
		afterUpdate: (user, { id, patch, operation, session }) => {
			if ('email' in patch) queue.push({ id, at: new Date(), operation, session });
		},
	},
});
```

| In every context | Type | What it is |
| --- | --- | --- |
| `operation` | `WriteOperation` | `'create'`, `'updateMany'`, `'upsert'`, `'hardDelete'`, … |
| `collection` | `TypedCollection<Def>` | the collection the write runs on, session and actor included |
| `session` | `ClientSession \| undefined` | the transaction, if there is one |
| `actor` | `ActorOf<Def> \| undefined` | who is writing, as `as(actor)` set it |
| `hard` | `boolean` | delete hooks only: `true` for a hard delete, and for a `delete` on a collection that does not soft delete |

The write has already happened when an `after` hook runs: throwing rejects
the call and undoes nothing — unless the write ran in a
[transaction](transactions.md) and the hook wrote through `context.session`.

## After an upsert

The arguments are rebuilt, because the write that ran was neither a `create`
nor an `update`: `afterCreate` gets `values` read back off the stored
document, less the stamps the collection keeps, and `afterUpdate` gets
`{ id, patch }` where the patch is what the upsert was given. Neither is
given the filter. A hook that must tell them apart reads
`context.operation`, which is `'upsert'`. See [Upsert](upsert.md#which-half-ran).

## Sharing a set

`hooks` takes an array: each set runs in order, and every `before` sees what
the previous one returned. A set written once is typed by the collection it
is for.

```ts
import type { CollectionHooks } from '@nxgt/mongo';
import { users } from './collections';

export const auditUsers: CollectionHooks<typeof users> = {
	afterCreate: (user, { session }) => log('user.created', user.id, session),
	afterDelete: (user, { session }) => log('user.deleted', user.id, session),
};

const collection = getCollection(db, users, { hooks: [auditUsers, tenantScope] });
```

`withSession` and `as` keep the hooks, so a collection used inside a
transaction runs exactly the same ones.

## Two traps

**A hook that writes to its own collection runs the hooks again.**
`context.collection` is the collection the write runs on, hooks included, so
an `afterCreate` that creates in the same collection recurses. Write through
`context.collection.raw`, or another collection.

**A misspelt field in a `before` hook's answer compiles.** TypeScript does
not check a returned literal for extra properties, so
`({ values }) => ({ values: { ...values, emial } })` is accepted and the
schema then drops `emial` without a word. The same mistake passed to `create`
directly is refused.

## The signatures

```ts
type BeforeHook<Args, Context> = (
	args: Args,
	context: Context,
) => Args | undefined | void | Promise<Args | undefined | void>;

type AfterHook<Result, Args, Context> = (
	result: Result,
	context: Context & Args,
) => unknown;

interface CollectionHooks<Def> {
	beforeCreate?: BeforeHook<CreateArgs<Def>, HookContext<Def>>;
	afterCreate?: AfterHook<ReadDocumentOf<Def>, CreateArgs<Def>, HookContext<Def>>;
	beforeUpsert?: BeforeHook<UpsertArgs<Def>, HookContext<Def>>;
	beforeUpdate?: BeforeHook<UpdateArgs<Def>, HookContext<Def>>;
	afterUpdate?: AfterHook<ReadDocumentOf<Def>, UpdateArgs<Def>, HookContext<Def>>;
	beforeUpdateMany?: BeforeHook<UpdateManyArgs<Def>, HookContext<Def>>;
	afterUpdateMany?: AfterHook<number, UpdateManyArgs<Def>, HookContext<Def>>;
	beforeDelete?: BeforeHook<DeleteArgs<Def>, DeleteHookContext<Def>>;
	afterDelete?: AfterHook<ReadDocumentOf<Def>, DeleteArgs<Def>, DeleteHookContext<Def>>;
	beforeDeleteMany?: BeforeHook<DeleteManyArgs<Def>, DeleteHookContext<Def>>;
	afterDeleteMany?: AfterHook<number, DeleteManyArgs<Def>, DeleteHookContext<Def>>;
	beforeRestore?: BeforeHook<DeleteArgs<Def>, HookContext<Def>>;
	afterRestore?: AfterHook<ReadDocumentOf<Def>, DeleteArgs<Def>, HookContext<Def>>;
}
```

`beforeRestore` and `afterRestore` are `never` on a collection that does not
soft delete: there is nothing to restore there.

## Next

- [Documents](documents.md) — the writes these run around.
- [Transactions](transactions.md) — making an `after` hook part of the write.
