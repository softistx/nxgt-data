import { describe, expect, test } from 'bun:test';
import { rejection } from '../../test/rejection';
import { collections, useMongo } from '../../test/wiring';
import { InvalidCursorError } from '../errors/data-error';
import { defineMongo } from './config/define-mongo';
import { openMongo } from './open-mongo';

const { server, track } = useMongo('wiring-cursor-scope');

const rows = [
	{ email: 'a@example.com' },
	{ email: 'b@example.com' },
	{ email: 'c@example.com' },
];

const open = async (options?: { cursorScope?: string }) =>
	track(
		await openMongo(
			defineMongo({
				uri: server.uri,
				collections,
				...(options ? { options } : {}),
			}),
		),
	);

describe('the default cursor scope', () => {
	test('binds the cursors of a call that gives no scope', async () => {
		const scoped = await open({ cursorScope: 'tenant:a' });
		await scoped.db.users.createMany(rows);
		const page = await scoped.db.users.paginateByCursor({ limit: 1 });
		expect(page.nextCursor).toBeString();

		const other = await open({ cursorScope: 'tenant:b' });
		const error = await rejection(
			other.db.users.paginateByCursor({ after: page.nextCursor, limit: 1 }),
		);
		expect(error).toBeInstanceOf(InvalidCursorError);
		expect(String(error)).toContain('another scope');

		const next = await scoped.db.users.paginateByCursor({
			after: page.nextCursor,
			limit: 1,
		});
		expect(next.items).toHaveLength(1);
	});

	test('is the scope a call gives itself', async () => {
		const scoped = await open({ cursorScope: 'tenant:a' });
		await scoped.db.users.createMany(rows);
		const byDefault = await scoped.db.users.paginateByCursor({ limit: 1 });
		const explicit = await scoped.db.users.paginateByCursor({
			limit: 1,
			scope: 'tenant:a',
		});
		expect(explicit.nextCursor).toBe(byDefault.nextCursor);
	});

	test('is outranked by the scope of the call', async () => {
		const scoped = await open({ cursorScope: 'tenant:a' });
		await scoped.db.users.createMany(rows);
		const page = await scoped.db.users.paginateByCursor({
			limit: 1,
			scope: 'archive',
		});
		const other = await open();
		const next = await other.db.users.paginateByCursor({
			after: page.nextCursor,
			limit: 1,
			scope: 'archive',
		});
		expect(next.items).toHaveLength(1);
		const refused = await rejection(
			scoped.db.users.paginateByCursor({ after: page.nextCursor, limit: 1 }),
		);
		expect(refused).toBeInstanceOf(InvalidCursorError);
	});

	test('leaves a Mongo without it unscoped', async () => {
		const mongo = await open();
		await mongo.db.users.createMany(rows);
		const page = await mongo.db.users.paginateByCursor({ limit: 1 });
		const scoped = await rejection(
			mongo.db.users.paginateByCursor({
				after: page.nextCursor,
				limit: 1,
				scope: 'x',
			}),
		);
		expect(scoped).toBeInstanceOf(InvalidCursorError);
	});

	test('is refused when it is not a string', async () => {
		const mongo = await open({ cursorScope: 1 as never });
		const error = await rejection(mongo.db.users.paginateByCursor());
		expect(error).toBeInstanceOf(TypeError);
	});
});
