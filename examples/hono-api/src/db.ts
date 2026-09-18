import { defineConfig, type KitOf } from '@nxgt/mongo-kit';
import * as collections from './collections';

/**
 * The application's MongoDB, described once. It connects to nothing and
 * reads the environment here, where the application starts, so a missing
 * variable is a startup error rather than a surprise on the first request.
 */
export const config = defineConfig({
	uri: process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/blog',
	collections,
	options: { maxPageSize: 50 },
});

/** This application's kit, read from the configuration rather than written twice. */
export type Kit = KitOf<typeof config>;
