import type { NewDocumentOf, ReadDocumentOf } from '@nxgt/mongo';
import type { ObjectId } from 'mongodb';
import type { Kit } from '../../db';
import type { users } from './users.model';

export type User = ReadDocumentOf<typeof users>;

/**
 * The kit comes first, as `@nxgt/mongo`'s own functions take their context
 * first: a service holds nothing of its own, so it can be called with the
 * kit of a request, of a script, or of a test, and reads the same.
 *
 * It is the **request's** kit, so every write here stamps that user without
 * the service having to say so.
 */
export function createUser(
	kit: Kit,
	values: NewDocumentOf<typeof users>,
): Promise<User> {
	return kit.db.users.create(values);
}

/** `undefined` when there is no such user, as `@nxgt/mongo` answers it. */
export function findUser(kit: Kit, id: ObjectId): Promise<User | undefined> {
	return kit.db.users.findById(id);
}

/**
 * This module's slice of what a handler is given, bound to one request's
 * kit. The module declares it, so adding a service here is one edit and
 * `context.ts` never learns what a module does.
 */
export function buildUserServices(kit: Kit) {
	return {
		create: (values: NewDocumentOf<typeof users>) => createUser(kit, values),
		find: (id: ObjectId) => findUser(kit, id),
	};
}

/** Read off the builder, so the signatures are never written twice. */
export type UserServices = ReturnType<typeof buildUserServices>;
