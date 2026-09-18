import type { NewDocumentOf, Page, ReadDocumentOf } from '@nxgt/mongo';
import { NotFoundError } from '@nxgt/mongo';
import type { ObjectId } from 'mongodb';
import type { Kit } from '../../db';
import type { articles } from './articles.model';

export type Article = ReadDocumentOf<typeof articles>;

export interface ArticleQuery {
	page?: number | undefined;
	pageSize?: number | undefined;
}

/** Most recent first. `maxPageSize` is the configuration's, not a handler's. */
export function listArticles(
	kit: Kit,
	query: ArticleQuery = {},
): Promise<Page<Article>> {
	return kit.db.articles.paginate({
		page: query.page,
		pageSize: query.pageSize,
		sort: { createdAt: -1 },
	});
}

/**
 * Writes an article and raises its author's count, in one transaction —
 * `undefined` when the kit's user is no user.
 *
 * The driver may run the body twice on a transient error, so the count is
 * read **inside** the transaction and never from anything the caller kept.
 */
export async function writeArticle(
	kit: Kit,
	values: NewDocumentOf<typeof articles>,
): Promise<Article | undefined> {
	const author = kit.actor;
	if (!author) {
		// `async`, so a function that announces a promise rejects rather than
		// throwing at the call site.
		throw new TypeError(
			'writeArticle: this kit stamps nobody, so nobody writes',
		);
	}
	return kit.transaction(async (tx) => {
		const user = await tx.db.users.findById(author);
		if (!user) return undefined;
		const article = await tx.db.articles.create(values);
		await tx.db.users.update(user._id, { articles: user.articles + 1 });
		return article;
	});
}

/**
 * Soft delete: the document stays, with the time it went, and every read
 * leaves it out from here on. `false` when there was nothing to take back.
 */
export async function removeArticle(kit: Kit, id: ObjectId): Promise<boolean> {
	try {
		await kit.db.articles.delete(id);
		return true;
	} catch (error) {
		if (error instanceof NotFoundError) return false;
		throw error;
	}
}

/** This module's slice of the services, as `users.service.ts` declares its own. */
export function buildArticleServices(kit: Kit) {
	return {
		list: (query?: ArticleQuery) => listArticles(kit, query),
		write: (values: NewDocumentOf<typeof articles>) =>
			writeArticle(kit, values),
		remove: (id: ObjectId) => removeArticle(kit, id),
	};
}

export type ArticleServices = ReturnType<typeof buildArticleServices>;
