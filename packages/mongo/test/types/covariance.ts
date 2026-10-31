// `Mongo<C>` stays covariant in its config, and two configs that differ only
// in wiring keys (`autoSync`) hold assignable Mongos. Checked by
// `tsc --noEmit`, never run. 0.25.0 broke both through `database()`.

import type { MongoClient } from 'mongodb';
import { z } from 'zod';
import {
	defineCollection,
	defineMongo,
	type Mongo,
	type MongoOf,
	openMongo,
} from '../../src';

declare const client: MongoClient;

const item = defineCollection({
	name: 'items',
	schema: z.object({ title: z.string() }),
});
const withSync = defineMongo({
	client,
	database: 'app',
	collections: { item },
	autoSync: true,
});
const plain = defineMongo({ client, database: 'app', collections: { item } });

const mongo = await openMongo(plain);

// The reported case: no `autoSync` where `MongoOf<config with autoSync>` is expected.
export const sameCollections: MongoOf<typeof withSync> = mongo;

// As in 0.24.1: a plain cast to the top and bottom Mongos.
export const toNever = mongo as Mongo<never>;
export const toUnknown = mongo as Mongo<unknown>;
