import { Hono } from 'hono';
import { api } from '../../api';
import type { Env } from '../../context';
import type { Article } from '../../generated/types';
import type { Article as StoredArticle } from './articles.service';

/** The stored article, as the spec describes it. */
function toArticle(article: StoredArticle): Article {
	return {
		id: article.id,
		title: article.title,
		body: article.body,
		// The kit stamped it from the actor of the request that wrote it.
		authorId: String(article.createdBy),
		createdAt: article.createdAt.toISOString(),
	};
}

/** This module's app, as `users.route.ts` exports its own. */
export const router = new Hono<Env>();

const routes = api.routes(router, { tag: 'articles' });

routes.get('/articles', async (c) => {
	const found = await c.get('services').articles.list(c.req.valid('query'));
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
	// The transaction across users and articles is the service's; what the
	// handler decides is what `undefined` means over HTTP.
	const written = await c.get('services').articles.write(c.req.valid('json'));
	if (!written) return c.json({ message: 'errors.no-such-author' }, 404);
	return c.json(toArticle(written), 201);
});

routes.patch('/articles/{id}', async (c) => {
	const written = await c
		.get('services')
		.articles.edit(c.req.valid('param').id, c.req.valid('json'));
	if (!written) return c.json({ message: 'errors.not-found' }, 404);
	return c.json(toArticle(written), 200);
});

routes.delete('/articles/{id}', async (c) => {
	const removed = await c
		.get('services')
		.articles.remove(c.req.valid('param').id);
	if (!removed) return c.json({ message: 'errors.not-found' }, 404);
	return c.body(null, 204);
});
