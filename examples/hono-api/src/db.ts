import { defineMongo, type MongoOf } from '@nxgt/mongo';
import * as collections from './collections';
import { env } from './env';

/**
 * The application's MongoDB, described once. It connects to nothing, and it
 * reads no variable of its own: `env.MONGO_URI` was parsed and defaulted
 * before this module was evaluated.
 */
export const config = defineMongo({
	uri: env.MONGO_URI,
	collections,
	options: { maxPageSize: 50 },
});

/** This application's mongo, read from the configuration rather than written twice. */
export type AppMongo = MongoOf<typeof config>;
