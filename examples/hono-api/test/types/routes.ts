import { api } from '../../src/api';
import { router } from '../../src/modules/users';

/**
 * What the module boundary refuses, measured rather than claimed: a registry
 * bounded to one tag offers only that module's paths. Nothing imports this
 * file — `tsc --noEmit` reading it is the whole test.
 */
const routes = api.routes(router, { tag: 'users' });

// @ts-expect-error `/articles` belongs to the articles module, not this one.
routes.get('/articles', (c) => c.json({ message: 'errors.not-found' }, 404));
