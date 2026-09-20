# Aggregation

Three helpers for what comes up most — distinct values, counts per group,
related documents — typed by the schema and leaving soft-deleted documents
out, as every read does. Anything else is `.aggregate()`, which is on the
collection too.

```ts
import { getCollection } from '@nxgt/mongo';
import { members, teams } from './collections';

const collection = getCollection(db, members);

await collection.distinct('level');                 // ['junior', 'senior']
await collection.groupBy('level', { measures: { average: { avg: 'score' } } });
await collection.populate(await collection.findMany(), {
	team: { from: getCollection(db, teams), by: 'teamId' },
});
```

All three take `withDeleted: true` to keep soft-deleted documents in.

## `distinct`

The distinct values of a field among the documents that match. An array
field gives its elements, in the server's order, and never `undefined`.

```ts
await collection.distinct('level');                        // every level
await collection.distinct('tags', { teamId });             // among one team's members
await collection.distinct('level', {}, { withDeleted: true });
```

It takes no collation and no hint; `raw.distinct` is the driver's own, which
does — and which does not filter soft-deleted documents out.

```ts
distinct<K extends FieldOf<Def>>(
	field: K,
	filter?: FilterOf<Def>,
	options?: ReadOptions,
): Promise<DistinctOf<Def, K>[]>;
```

## `groupBy`

Each group's `key`, its `count`, and the measures asked for.

```ts
const byStatus = await getCollection(db, orders).groupBy('status', {
	filter: { createdAt: { $gte: monthStart } },
	measures: {
		total: { sum: 'amount' },
		average: { avg: 'amount' },
		last: { max: 'createdAt' },
	},
});
// [{ key: 'paid', count: 12, total: 4310, average: 359.2, last: Date }, …]
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `measures` | `Record<string, Measure>` | `{}` | one of `sum`, `avg`, `min`, `max` per name |
| `filter` | `FilterOf<Def>` | `{}` | which documents to group |
| `sort` | `'count' \| 'key'` | `'count'` | the largest groups first, ties by key — or by key |
| `limit` | `number` | — | keep the first groups |
| `withDeleted` | `boolean` | `false` | |

`sum` and `avg` take numeric fields, `min` and `max` any field; a measure may
not be called `key`, `count` or `_id`. Documents without the grouped field
are one group, keyed `null`. A group whose measured field is missing
everywhere sums to `0` and averages to `null`.

```ts
// @ts-expect-error a name is not a number
await collection.groupBy('level', { measures: { n: { sum: 'name' } } });
// @ts-expect-error `count` is the group's own
await collection.groupBy('level', { measures: { count: { sum: 'score' } } });
```

A bad measure, `sort` or `limit` rejects with a `TypeError` — as every method
here rejects rather than throws.

```ts
groupBy<K extends FieldOf<Def>, const M extends Measures<Def>>(
	field: K,
	options?: GroupByOptions<Def, M>,
): Promise<Group<Def, K, M>[]>;
```

## `populate`

Documents you already have, with their related documents under each
relation's name — **one query per relation**, however many documents there
are.

```ts
const found = await collection.findMany({ limit: 50 });

const withRelations = await collection.populate(found, {
	team: { from: teamsCollection, by: 'teamId' },          // a team, or null
	mentors: { from: collection, by: 'mentorIds' },         // a list field gives a list, in its order
	mentees: { from: collection, on: 'mentorIds' },         // the members that point to this one
});

withRelations[0]?.team?.name;
withRelations[0]?.mentees.length;
```

| Key | Type | Effect |
| --- | --- | --- |
| `from` | a bound collection | where the related documents are read |
| `by` | a field of **these** documents | follows it: a list field gives a list (`[]` when missing), any other a document or `null` |
| `on` | a field of the **related** documents | gathers the ones that point back |
| `withDeleted` | `boolean` | keep soft-deleted related documents |

The related collection reads as it always does — its session, its soft
delete. Pass `withSession(session)` inside a
[transaction](transactions.md):

```ts
await withTransaction(client, async (session) => {
	const scoped = collection.withSession(session);
	return scoped.populate(await scoped.findMany(), {
		team: { from: teamsCollection.withSession(session), by: 'teamId' },
	});
});
```

`populate` returns copies and leaves your documents alone. Ids are matched by
value, whatever their type: an `ObjectId`, a date, an embedded document.

```ts
// @ts-expect-error `name` is not a reference to teams
await collection.populate(found, { team: { from: teamsCollection, by: 'name' } });
// @ts-expect-error `name` is already a field of the document
await collection.populate(found, { name: { from: teamsCollection, by: 'teamId' } });
```

Two traps:

- **It matches ids by type, not by collection.** Any `ObjectId` field can
  point to any collection keyed by `ObjectId`; the type checks the kind of
  id, and nothing more can. A `by` naming the wrong collection compiles and
  finds nothing.
- **Its `$in` holds every id at once.** A page of ten thousand documents
  makes a filter of ten thousand ids: [page](pagination.md) first, then
  populate.

```ts
populate<Doc extends ReadDocumentOf<Def>, const R>(
	documents: readonly Doc[],
	relations: R & Relations<Def, R>,
): Promise<Populated<Def, Doc, R>[]>;
```

## Everything else

The driver's aggregation is on the same object, and `raw` is its collection:
neither filters soft-deleted documents out, and neither reads the strings
that arrive from outside.

```ts
await collection.aggregate([
	{ $match: { deletedAt: null } },
	{ $group: { _id: '$teamId', n: { $sum: 1 } } },
]).toArray();
```

There is no pipeline builder here, on purpose: the helpers above cover the
common cases, and `.aggregate()` is the driver's own, untouched.

## Next

- [Pagination](pagination.md) — pages to populate.
- [Documents](documents.md) — `raw`, and what it does not do for you.
