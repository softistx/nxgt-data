import { GuardError } from '@nxgt/redis-guard';
import { Hono } from 'hono';
import { api } from '../../api';
import type { Env } from '../../context';
import type { Article } from '../../generated/types';
import { rateLimitHeaders, seconds } from '../../guards';
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
	const guards = c.get('guards').articles;
	const user = c.get('actor');

	// The limit first, so a denied request takes no idempotency key and
	// writes nothing. A replay is a request too, and counts.
	const limit = await guards.writes.consume({ user });
	for (const [name, value] of rateLimitHeaders(limit)) c.header(name, value);
	if (!limit.allowed) return c.json({ message: 'errors.rate-limited' }, 429);

	// The transaction across users and articles is the service's; what the
	// handler decides is what `null` means over HTTP.
	const write = async () => {
		const written = await c.get('services').articles.write(c.req.valid('json'));
		return written ? toArticle(written) : null;
	};

	const key = c.req.valid('header')['idempotency-key'];
	try {
		const { value, replayed } =
			key === undefined
				? { value: await write(), replayed: false }
				: await guards.creation.run({ user, key }, write, {
						// The raw body, as the client sent it — the validator read
						// it through `c.req`, which keeps the text for this.
						fingerprint: await c.req.text(),
						wait: guards.wait,
					});
		// A replay answers exactly what the first request answered, status
		// included; only this header tells them apart.
		if (replayed) c.header('Idempotent-Replayed', 'true');
		if (!value) return c.json({ message: 'errors.no-such-author' }, 404);
		return c.json(value, 201);
	} catch (error) {
		// Only what the guard decided is mapped here. Anything else — a
		// failed write, Redis down, `INVALID`, `LEASE_LOST` — goes on to
		// Hono's error handler, which answers 500.
		if (!(error instanceof GuardError)) throw error;
		if (error.code === 'IN_PROGRESS') {
			c.header('Retry-After', seconds(error.retryAfter ?? 0));
			return c.json({ message: 'errors.idempotency-in-progress' }, 409);
		}
		if (error.code === 'MISMATCH') {
			return c.json({ message: 'errors.idempotency-key-reused' }, 422);
		}
		throw error;
	}
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
