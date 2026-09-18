import { NotFoundError, type ReadDocumentOf, tryObjectId } from '@nxgt/mongo';
import type { Hono } from 'hono';
import type { Env } from '../app';
import type { createApi } from '../generated/hono';
import type { Article } from '../generated/types';
import type { articles } from '../models/article.model';

/** The stored article, as the spec describes it. */
function toArticle(article: ReadDocumentOf<typeof articles>): Article {
	return {
		id: article.id,
		title: article.title,
		body: article.body,
		// The kit stamped it from the actor of the request that wrote it.
		authorId: String(article.createdBy),
		createdAt: article.createdAt.toISOString(),
	};
}

export function articleRoutes(
	app: Hono<Env>,
	api: ReturnType<typeof createApi>,
): void {
	const routes = api.routes(app);

	routes.get('/articles', async (c) => {
		const { page, pageSize } = c.req.valid('query');
		// `maxPageSize: 50` is in the configuration, so a larger `pageSize` is
		// lowered to it rather than refused.
		const found = await c.get('db').articles.paginate({
			page,
			pageSize,
			sort: { createdAt: -1 },
		});
		return c.json(
			{
				items: found.items.map(toArticle),
				page: found.page,
				pageSize: found.pageSize,
				total: found.total,
				pageCount: found.pageCount,
			},
			200,
		);
	});

	routes.post('/articles', async (c) => {
		const body = c.req.valid('json');
		// Two collections, one transaction. The driver may run this body twice
		// on a transient error, so the count is read inside it and never from
		// anything the handler kept.
		const written = await c.get('kit').transaction(async (tx) => {
			const author = await tx.db.users.findById(c.get('actor'));
			if (!author) return null;
			const article = await tx.db.articles.create(body);
			await tx.db.users.update(author._id, { articles: author.articles + 1 });
			return article;
		});
		if (!written) return c.json({ message: 'errors.no-such-author' }, 404);
		return c.json(toArticle(written), 201);
	});

	routes.delete('/articles/{id}', async (c) => {
		const id = tryObjectId(c.req.valid('param').id);
		if (!id) return c.json({ message: 'errors.not-found' }, 404);
		try {
			// Soft delete: the document stays, with the time it went, and every
			// read leaves it out from here on.
			await c.get('db').articles.delete(id);
		} catch (error) {
			if (error instanceof NotFoundError) {
				return c.json({ message: 'errors.not-found' }, 404);
			}
			throw error;
		}
		return c.body(null, 204);
	});
}
