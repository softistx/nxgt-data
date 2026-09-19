import { NotFoundError, type ReadDocumentOf } from '@nxgt/mongo';
import type { ObjectId } from 'mongodb';
import type { Kit } from '../../db';
import type { NewUser, UserPatch } from '../../generated/types';
import type { users } from './users.model';

export type User = ReadDocumentOf<typeof users>;

/**
 * The users' work, over one kit.
 *
 * The kit is the **constructor's**, and it is the kit of whatever asked —
 * a request, a script, a test. When it comes from a request it is
 * `kit.as(actor)`, so every write here stamps that user without a method
 * having to say so.
 *
 * `create` takes `NewUser`, the body the spec describes and the router has
 * already validated — not the stored document. A field the API does not
 * offer, `articles` among them, therefore cannot reach a write from a
 * handler: it is the collection's default or the transaction's doing.
 */
export class UserService {
	constructor(private readonly kit: Kit) {}

	create(values: NewUser): Promise<User> {
		return this.kit.db.users.create(values);
	}

	/**
	 * `undefined` when there is no such user, as `@nxgt/mongo` answers it.
	 *
	 * It takes an id in either form — what the collection takes. A path
	 * parameter carries the **string**, and `@nxgt/mongo` reads it as the
	 * `ObjectId` the collection stores, so nothing here converts by hand; a
	 * string that is no id matches nothing, which is the 404 the handler
	 * wanted anyway. A caller that already holds the `ObjectId` passes that.
	 */
	find(id: ObjectId | string): Promise<User | undefined> {
		return this.kit.db.users.findById(id);
	}

	/**
	 * The fields the patch names, and no others — `undefined` when there is
	 * no such user.
	 *
	 * `ConflictError` is left to travel: a second user on one email is the
	 * unique index's answer, and the handler turns it into a 409, exactly as
	 * it does for a create.
	 */
	async change(
		id: ObjectId | string,
		values: UserPatch,
	): Promise<User | undefined> {
		try {
			return await this.kit.db.users.update(id, values);
		} catch (error) {
			if (error instanceof NotFoundError) return undefined;
			throw error;
		}
	}
}
