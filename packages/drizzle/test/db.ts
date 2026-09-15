import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { DDL } from './schema';

/**
 * A real PostgreSQL, in memory, in process: PGlite. One per spec file, as
 * starting one takes a moment; `reset` empties it between tests.
 */
export async function createTestDb() {
	const client = new PGlite();
	await client.exec(DDL);
	const db = drizzle({ client });
	return {
		db,
		client,
		reset: () =>
			client.exec(
				'truncate teams, users, posts, memberships, logs restart identity cascade',
			),
		close: () => client.close(),
	};
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>['db'];
