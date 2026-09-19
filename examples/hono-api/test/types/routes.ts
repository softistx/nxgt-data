import { api } from '../../src/api';
import type { Kit } from '../../src/db';
import { ArticleService } from '../../src/modules/articles/articles.service';
import { router } from '../../src/modules/users';
import { UserService } from '../../src/modules/users/users.service';

/**
 * What the module boundary refuses, measured rather than claimed: a registry
 * bounded to one tag offers only that module's paths. Nothing imports this
 * file — `tsc --noEmit` reading it is the whole test.
 */
const routes = api.routes(router, { tag: 'users' });

// @ts-expect-error `/articles` belongs to the articles module, not this one.
routes.get('/articles', (c) => c.json({ message: 'errors.not-found' }, 404));

/**
 * A service speaks the **API's** types, not the stored document's: `create`
 * and `write` take the body the spec declares, already validated, so a field
 * the API does not offer cannot reach a write from a handler.
 */
const users = new UserService({} as Kit);
const articles = new ArticleService({} as Kit);

users.create({
	email: 'ada@example.com',
	// @ts-expect-error `articles` is the collection's, raised by the transaction
	articles: 7,
});

// @ts-expect-error a new user needs the email the spec declares
users.create({ name: 'Ada' });

articles.write({
	title: 'a',
	body: 'b',
	// @ts-expect-error the author is stamped from the kit, never passed
	createdBy: 'someone',
});

// @ts-expect-error the kit is the constructor's; a method never takes one
void articles.list({} as Kit);
