import type { Kit } from './db';
import {
	type ArticleServices,
	buildArticleServices,
} from './modules/articles/articles.service';
import {
	buildUserServices,
	type UserServices,
} from './modules/users/users.service';

/**
 * What a handler is given: the services of this request, already bound to
 * the kit that stamps its user. A handler never reaches the kit itself, so
 * it cannot write as somebody else, and cannot close it.
 *
 * Each module declares its own slice; this file only composes them, the way
 * `collections.ts` only gathers the models.
 */
export interface Services {
	readonly users: UserServices;
	readonly articles: ArticleServices;
}

/** What every module's handlers read off the Hono context. */
export interface Env {
	Variables: {
		services: Services;
	};
}

/** Binds one request's kit to every module's services, once. */
export function buildServices(kit: Kit): Services {
	return {
		users: buildUserServices(kit),
		articles: buildArticleServices(kit),
	};
}
