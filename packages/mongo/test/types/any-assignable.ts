// `Mongo<any>` converts to a structural type whose `db` is typed, as in 0.25.0
// and before: `any` has to flow through `SoleScope`, not collapse to a bare
// `Db`. 0.25.1 broke it. Non-`any` configs stay checked. Checked by
// `tsc --noEmit`, never run.

import type { Db, MongoClient } from 'mongodb';
import { z } from 'zod';
import {
	defineCollection,
	defineMongo,
	type Mongo,
	openMongo,
} from '../../src';

declare const client: MongoClient;
declare const anyMongo: Mongo<any>;

interface Structural {
	readonly db: Db & { readonly marker: 'typed' };
}

// The reported case: no cast.
export const fromAny: Structural = anyMongo;

// A real config is not widened to `any`: its `db` is not that structural type.
const item = defineCollection({
	name: 'items',
	schema: z.object({ title: z.string() }),
});
const mongo = await openMongo(
	defineMongo({ client, database: 'app', collections: { item } }),
);
// @ts-expect-error a typed Mongo is still not a `Structural`
export const fromTyped: Structural = mongo;
