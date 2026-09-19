import { tryObjectId } from '@nxgt/mongo';
import { createMiddleware } from 'hono/factory';
import { buildServices } from '../context';
import type { Kit } from '../db';

export const provideServices = (kit: Kit) =>
	createMiddleware(async (c, next) => {
		const actor = tryObjectId(c.req.header('x-user-id'));
		if (!actor) return c.json({ message: 'errors.unauthenticated' }, 401);
		c.set('services', buildServices(kit.as(actor)));
		await next();
	});
