import { createMiddleware } from 'hono/factory';
import type { Env, Guards } from '../context';

/**
 * Hands every request the guards the app bound once. Nothing here consumes
 * a limit: which route is guarded, and by what, is the route's to say.
 */
export const provideGuards = (guards: Guards) =>
	createMiddleware<Env>(async (c, next) => {
		c.set('guards', guards);
		await next();
	});
