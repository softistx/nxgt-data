import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { useKit } from '../../../test/kit';
import { createUser, findUser } from './users.service';

/**
 * The services take the kit, so they are called here as a script or a job
 * would call them — no HTTP, no Hono, no spec. That is what the layer buys.
 */
const state = useKit('blog-users');

describe('the user service', () => {
	test('creates one and reads it back', async () => {
		const author = await createUser(state.kit, { email: 'ada@example.com' });
		expect(author.articles).toBe(0);
		expect(await findUser(state.kit.as(author._id), author._id)).toMatchObject({
			email: 'ada@example.com',
		});
	});

	test('answers undefined for a user that is not there', async () => {
		expect(await findUser(state.kit, new ObjectId())).toBeUndefined();
	});
});
