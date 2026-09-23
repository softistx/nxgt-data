import type { RedisClient } from 'bun';
import type { Kit } from './db';
import { ArticleGuards } from './modules/articles/articles.guards';
import { ArticleService } from './modules/articles/articles.service';
import { UserService } from './modules/users/users.service';

/**
 * What a handler is given: the services of this request, each built on the
 * kit that stamps its user. A handler never reaches the kit itself, so it
 * cannot write as somebody else, and cannot close it.
 *
 * The services are the classes themselves, so a module adding a method is
 * one edit in that module and none here — this file only composes, the way
 * `collections.ts` only gathers the models.
 */
export interface Services {
	readonly users: UserService;
	readonly articles: ArticleService;
}

/**
 * The modules' guards, bound to the application's Redis. Unlike the
 * services they carry no user — a guard is keyed by one on each call — so
 * they are bound once per app, and every request shares them.
 */
export interface Guards {
	readonly articles: ArticleGuards;
}

/** What the guards may be told, per app. The specs are what set it. */
export interface GuardOptions {
	/**
	 * How long a repeat of a running `Idempotency-Key` waits for its replay,
	 * in milliseconds, before it is a 409. Default 2 000.
	 */
	readonly idempotencyWait?: number;
}

/** What every module's handlers read off the Hono context. */
export interface Env {
	Variables: {
		services: Services;
		guards: Guards;
		/** The user the request carries, as the hex string a guard keys on. */
		actor: string;
	};
}

/** Builds one request's services on its kit, once. */
export function buildServices(kit: Kit): Services {
	return {
		users: new UserService(kit),
		articles: new ArticleService(kit),
	};
}

/** Binds the guards once, for the app: binding sends nothing to Redis. */
export function bindGuards(
	redis: RedisClient,
	options: GuardOptions = {},
): Guards {
	return {
		articles: new ArticleGuards(redis, options.idempotencyWait),
	};
}
