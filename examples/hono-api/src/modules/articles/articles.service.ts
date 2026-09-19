import { NotFoundError, type Page, type ReadDocumentOf } from '@nxgt/mongo';
import type { ObjectId } from 'mongodb';
import type { Kit } from '../../db';
import type { ArticlePatch, NewArticle } from '../../generated/types';
import type { articles } from './articles.model';

export type Article = ReadDocumentOf<typeof articles>;

export interface ArticleQuery {
	page?: number | undefined;
	pageSize?: number | undefined;
}

/** The articles' work, over one kit — see `UserService` for what that means. */
export class ArticleService {
	constructor(private readonly kit: Kit) {}

	/** Most recent first. `maxPageSize` is the configuration's, not a handler's. */
	list(query: ArticleQuery = {}): Promise<Page<Article>> {
		return this.kit.db.articles.paginate({
			page: query.page,
			pageSize: query.pageSize,
			sort: { createdAt: -1 },
		});
	}

	/**
	 * Writes an article and raises its author's count, in one transaction —
	 * `undefined` when the kit's user is no user.
	 *
	 * `values` is `NewArticle`, the validated body: the author is never one
	 * of them, because it is stamped from the kit's actor.
	 *
	 * The driver may run the body twice on a transient error, so the count is
	 * read **inside** the transaction and never from anything the caller kept.
	 */
	async write(values: NewArticle): Promise<Article | undefined> {
		const author = this.kit.actor;
		if (!author) {
			// `async`, so a method that announces a promise rejects rather than
			// throwing at the call site.
			throw new TypeError(
				'ArticleService.write: this kit stamps nobody, so nobody writes',
			);
		}
		return this.kit.transaction(async (tx) => {
			const user = await tx.db.users.findById(author);
			if (!user) return undefined;
			const article = await tx.db.articles.create(values);
			await tx.db.users.update(user._id, { articles: user.articles + 1 });
			return article;
		});
	}

	/**
	 * The fields the patch names, and no others — `undefined` when there is
	 * no such article.
	 *
	 * `values` is `ArticlePatch`, so a field the API does not offer cannot
	 * reach the write from a handler. The collection stamps `updatedAt` and
	 * `updatedBy` on its own, from the kit's actor, which is why neither is
	 * spelled here.
	 */
	async edit(
		id: ObjectId | string,
		values: ArticlePatch,
	): Promise<Article | undefined> {
		try {
			return await this.kit.db.articles.update(id, values);
		} catch (error) {
			if (error instanceof NotFoundError) return undefined;
			throw error;
		}
	}

	/**
	 * Soft delete: the document stays, with the time it went, and every read
	 * leaves it out from here on. `false` when there was nothing to take back.
	 */
	async remove(id: ObjectId | string): Promise<boolean> {
		try {
			await this.kit.db.articles.delete(id);
			return true;
		} catch (error) {
			if (error instanceof NotFoundError) return false;
			throw error;
		}
	}
}
