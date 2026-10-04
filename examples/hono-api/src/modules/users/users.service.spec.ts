import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { useMongo } from '../../../test/mongo';
import { UserService } from './users.service';

/**
 * A service is built on a mongo, so it is built here as a script or a job
 * would build it — no HTTP, no Hono, no spec. That is what the layer buys.
 */
const state = useMongo('blog-users');

describe('the user service', () => {
	test('creates one and reads it back', async () => {
		const author = await new UserService(state.mongo).create({
			email: 'ada@example.com',
		});
		expect(author.articles).toBe(0);
		const asAuthor = new UserService(state.mongo.as(author._id));
		expect(await asAuthor.find(author.id)).toMatchObject({
			email: 'ada@example.com',
		});
	});

	test('answers undefined for a user that is not there', async () => {
		expect(
			await new UserService(state.mongo).find(new ObjectId().toHexString()),
		).toBeUndefined();
	});

	test('changes the fields it is given, and stamps the rest', async () => {
		const mongo = state.mongo;
		const created = await new UserService(mongo).create({
			email: 'grace@example.com',
		});
		const asSelf = new UserService(mongo.as(created._id));
		const changed = await asSelf.change(created.id, { name: 'Grace' });
		expect(changed).toMatchObject({
			email: 'grace@example.com',
			name: 'Grace',
		});
		// `updatedBy` is the Mongo's actor, written by the collection: nothing
		// in the service or the handler names it.
		expect(changed?.updatedBy).toEqual(created._id);
	});

	test('answers undefined for a user that is not there', async () => {
		expect(
			await new UserService(state.mongo).change(new ObjectId(), { name: 'x' }),
		).toBeUndefined();
	});
});
