import type { Kit } from './db';
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

/** What every module's handlers read off the Hono context. */
export interface Env {
	Variables: {
		services: Services;
	};
}

/** Builds one request's services on its kit, once. */
export function buildServices(kit: Kit): Services {
	return {
		users: new UserService(kit),
		articles: new ArticleService(kit),
	};
}
