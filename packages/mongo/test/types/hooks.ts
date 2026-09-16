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

// --- more of what is refused -------------------------------------------

getCollection(db, users, {
	// @ts-expect-error no such hook: a typo is the likeliest mistake
	hooks: { beforeCreat: () => {} },
});

const typo = { beforeCreat: () => {} };
// @ts-expect-error the same typo, through a variable
getCollection(db, users, { hooks: typo });

// @ts-expect-error a set for users, inside the array, is not one for posts
getCollection(db, posts, { hooks: [shared] });

getCollection(db, users, {
	// @ts-expect-error an id is an ObjectId
	hooks: { beforeUpdate: ({ patch }) => ({ id: 'abc', patch }) },
});

getCollection(db, users, {
	// A before hook's answer *replaces* the arguments, so an expression body
	// returning something else would delete with `id: undefined`.
	// @ts-expect-error an InsertOneResult is not `{ id }`
	hooks: {
		beforeDelete: ({ id }, { collection }) =>
			collection.db.collection('audit').insertOne({ id }),
	},
});

getCollection(db, users, {
	// @ts-expect-error async or not, the answer is `{ values }`
	hooks: { beforeCreate: async ({ values }) => values },
});

// --- what is accepted, on purpose --------------------------------------

// An after hook's answer is ignored, so returning the driver's promise is fine.
getCollection(db, users, {
	hooks: {
		afterCreate: (document, { collection, session }) =>
			collection.db
				.collection('audit')
				.insertOne({ user: document._id }, { session }),
	},
});

// Not refused, and cannot be: TypeScript does not check a returned literal
// for extra properties. The schema drops `emial` when it parses the write, so
// the fill silently does nothing. The README lists it under Traps.
getCollection(db, users, {
	hooks: {
		beforeCreate: ({ values }) => ({ values: { ...values, emial: 'x' } }),
	},
});
