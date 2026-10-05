import { defineIdempotency, defineRateLimit } from '@nxgt/redis';
import { zArticle } from '../../generated/zod';
import type { AppRedis } from '../../redis';

/**
 * Five writes a minute per author. The key is the **user the request
 * carries**, not an address: `x-user-id` is this API's credential, and a
 * limit on something a client can change at will — an `x-forwarded-for` from
 * no proxy of yours — would be a fresh bucket per value.
 */
export const articleWrites = defineRateLimit({
	name: 'articles.write',
	key: (params: { user: string }) => params.user,
	limit: 5,
	per: 60_000,
});

/**
 * One article per `Idempotency-Key`, per user: a key is unique only to the
 * client that made it up, so it is scoped to the user, and two users who
 * happen to pick the same one never share an answer.
 *
 * The result is the **API document** — what the first request answered —
 * checked by the spec's own schema, so a replay answers exactly that.
 * `null` is a result too: a write whose author is no user is a 404, and a
 * retry of it is the same 404, not a second try.
 */
export const articleCreation = defineIdempotency({
	name: 'articles.create',
	key: (params: { user: string; key: string }) =>
		`${params.user}/${params.key}`,
	ttl: 86_400,
	lease: 10_000,
	schema: zArticle.nullable(),
});

/** How long a repeat waits for a first request still running, by default. */
export const IDEMPOTENCY_WAIT = 2_000;

/**
 * The article guards, read off the application's Redis, which bound them
 * under its prefix when it opened: the definitions above are wired in
 * `redis.ts`, and nothing here is bound by hand.
 */
export class ArticleGuards {
	readonly writes: AppRedis['limits']['articleWrites'];
	readonly creation: AppRedis['idempotency']['articleCreation'];

	/**
	 * @param wait how long, in milliseconds, a repeat of a running key waits
	 *   for its replay before it is a 409. `0` answers 409 at once.
	 */
	constructor(
		redis: AppRedis,
		readonly wait: number = IDEMPOTENCY_WAIT,
	) {
		this.writes = redis.limits.articleWrites;
		this.creation = redis.idempotency.articleCreation;
	}
}
