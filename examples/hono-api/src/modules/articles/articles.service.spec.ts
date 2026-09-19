import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { useKit } from '../../../test/kit';
import { UserService } from '../users/users.service';
import { ArticleService } from './articles.service';

/**
 * A service is built on a kit, so it is built here as a script or a job
 * would build it — no HTTP, no Hono, no spec. That is what the layer buys.
 *
 * It is the one spec that reaches into another module: an article needs an
 * author, and creating one through the users module is what the application
 * does too.
 */
const state = useKit('blog-articles');

/** A kit that writes as a real user, the way the middleware builds one. */
async function asNewUser() {
	const author = await new UserService(state.kit).create({
		email: 'ada@example.com',
	});
	const kit = state.kit.as(author._id);
	return { author, kit, articles: new ArticleService(kit) };
}

describe('the article service', () => {
	test('stamps the kit`s user and raises their count, in one transaction', async () => {
		const { author, kit, articles } = await asNewUser();
		const article = await articles.write({ title: 'a', body: 'b' });
		expect(article?.createdBy).toEqual(author._id);
		expect(await new UserService(kit).find(author.id)).toMatchObject({
			articles: 1,
		});
	});

	test('writes nothing at all when the author is gone', async () => {
		const kit = state.kit.as(new ObjectId());
		expect(
			await new ArticleService(kit).write({ title: 'a', body: 'b' }),
		).toBeUndefined();
		expect(await state.kit.db.articles.count()).toBe(0);
	});

	test('refuses a kit that stamps nobody', async () => {
		// The root kit has no actor, so there is no author to write as.
		await expect(
			new ArticleService(state.kit).write({ title: 'a', body: 'b' }),
		).rejects.toThrow('stamps nobody');
	});

	test('lists them most recent first, and pages', async () => {
		const { articles } = await asNewUser();
		for (const title of ['one', 'two', 'three']) {
			await articles.write({ title, body: 'b' });
		}
		const page = await articles.list({ pageSize: 2 });
		expect(page.items.map((article) => article.title)).toEqual([
			'three',
			'two',
		]);
		expect(page).toMatchObject({ total: 3, pageCount: 2 });
	});

	test('lowers a page larger than the configuration allows', async () => {
		const { articles } = await asNewUser();
		await articles.write({ title: 'a', body: 'b' });
		// `maxPageSize: 50` is in the configuration, so 500 is lowered to it
		// rather than refused.
		expect(await articles.list({ pageSize: 500 })).toMatchObject({
			pageSize: 50,
		});
	});

	test('takes an article back, and keeps it', async () => {
		const { articles } = await asNewUser();
		const article = await articles.write({ title: 'a', body: 'b' });
		if (!article) throw new Error('the article was not written');
		expect(await articles.remove(article.id)).toBe(true);
		expect(await articles.list()).toMatchObject({ total: 0 });
		// Soft delete: the document is still there, with the time it went.
		expect(await state.kit.db.articles.raw.countDocuments()).toBe(1);
	});

	test('answers false for an article that is not there', async () => {
		const { articles } = await asNewUser();
		expect(await articles.remove(new ObjectId())).toBe(false);
	});
});
