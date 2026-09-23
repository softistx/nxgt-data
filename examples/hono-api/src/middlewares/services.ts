import { tryObjectId } from '@nxgt/mongo';
import { createMiddleware } from 'hono/factory';
import { buildServices, type Env } from '../context';
import type { Kit } from '../db';

export const provideServices = (kit: Kit) =>
	createMiddleware<Env>(async (c, next) => {
		const actor = tryObjectId(c.req.header('x-user-id'));
		if (!actor) return c.json({ message: 'errors.unauthenticated' }, 401);
		c.set('services', buildServices(kit.as(actor)));
		// The same user, as the string a guard keys on: checked here, once,
		// so no route keys a limit on a header nobody read.
		c.set('actor', actor.toHexString());
		await next();
	});
