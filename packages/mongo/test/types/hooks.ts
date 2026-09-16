// What the hooks' types refuse, checked by `tsc` and never run. Each
// `@ts-expect-error` must fire.

import type { Db, ObjectId } from 'mongodb';
import type { CollectionHooks } from '../../src';
import { getCollection } from '../../src';
import { posts, users } from '../schema';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
function assertType<T extends true>(_: T): void {}

declare const db: Db;

getCollection(db, users, {
	hooks: {
		beforeCreate: ({ values }, { actor, operation }) => {
			// The input, typed by the schema: email is required there.
			assertType<Equal<typeof values.email, string>>(true);
			assertType<Equal<typeof actor, ObjectId | undefined>>(true);
			assertType<Equal<typeof operation, import('../../src').WriteOperation>>(
				true,
			);
			return { values: { ...values, name: 'x' } };
		},
		afterCreate: (document) => {
			assertType<Equal<typeof document.id, string>>(true);
			assertType<Equal<typeof document.deletedAt, Date | null>>(true);
		},
		afterDelete: (document, { hard, id }) => {
			assertType<Equal<typeof hard, boolean>>(true);
			assertType<Equal<typeof id, ObjectId>>(true);
			assertType<Equal<typeof document.email, string>>(true);
		},
		// Restoring is there: users soft delete.
		beforeRestore: ({ id }) => {
			assertType<Equal<typeof id, ObjectId>>(true);
		},
	},
});

getCollection(db, users, {
	// @ts-expect-error a before hook gives back what it was given, not a bare document
	hooks: {
		beforeCreate: ({ values }) => values,
	},
});

getCollection(db, users, {
	// @ts-expect-error the email is a string
	hooks: {
		beforeCreate: ({ values }) => ({ values: { ...values, email: 1 } }),
	},
});

getCollection(db, users, {
	// @ts-expect-error a patch is checked against the document
	hooks: {
		beforeUpdate: ({ id }) => ({ id, patch: { email: 1 } }),
	},
});

getCollection(db, users, {
	hooks: {
		beforeCreate: (_args, context) => {
			// @ts-expect-error only a delete says whether it is hard
			context.hard;
		},
	},
});

getCollection(db, posts, {
	hooks: {
		afterCreate: (document) => {
			// @ts-expect-error posts have no email
			document.email;
		},
	},
});

getCollection(db, posts, {
	// @ts-expect-error posts do not soft delete, so there is nothing to restore
	hooks: {
		beforeRestore: () => {},
	},
});

// A hook set written once, typed for one collection, and shared: the plugin
// shape. One declared with no `return` must be accepted.
function lowerCaseEmail({ values }: { values: { email: string } }): void {
	values.email = values.email.toLowerCase();
}
const shared: CollectionHooks<typeof users> = { beforeCreate: lowerCaseEmail };
getCollection(db, users, { hooks: [shared, shared] });

// @ts-expect-error a set typed for users is not one for posts
getCollection(db, posts, { hooks: shared });
