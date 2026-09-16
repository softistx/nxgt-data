// What `onChange`'s types give and refuse, checked by `tsc` and never run.

import type { Db, ObjectId } from 'mongodb';
import type { ChangeOf, ReadDocumentOf, ResumeToken } from '../../src';
import { getCollection } from '../../src';
import { posts, users } from '../schema';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
function assertType<T extends true>(_: T): void {}

declare const db: Db;
const userRepo = getCollection(db, users);
const postRepo = getCollection(db, posts);

userRepo.onChange((change) => {
	assertType<Equal<typeof change.id, ObjectId>>(true);
	assertType<Equal<typeof change.at, Date>>(true);
	switch (change.type) {
		case 'create':
			// A create always carries its document.
			assertType<Equal<typeof change.document, ReadDocumentOf<typeof users>>>(
				true,
			);
			break;
		case 'update':
			assertType<
				Equal<typeof change.document, ReadDocumentOf<typeof users> | undefined>
			>(true);
			if (change.fields) {
				assertType<Equal<typeof change.fields.set.email, string | undefined>>(
					true,
				);
			}
			break;
		case 'delete':
			assertType<Equal<typeof change.hard, boolean>>(true);
			break;
		case 'restore':
			// users soft delete, so there are restores to hear about.
			break;
	}
});

// Typed by the schema, and keyed on its fields.
userRepo.onChange(() => {}, {
	events: ['delete', 'restore'],
	filter: { email: 'ada@example.com', age: { $gte: 18 } },
	withDeleted: true,
});

// @ts-expect-error email is a string
userRepo.onChange(() => {}, { filter: { email: 1 } });

// @ts-expect-error no such event
userRepo.onChange(() => {}, { events: ['insert'] });

postRepo.onChange((change) => {
	// @ts-expect-error posts do not soft delete: there is no restore to hear
	if (change.type === 'restore') return;
	// @ts-expect-error posts have no email
	change.document?.email;
});

// @ts-expect-error posts do not soft delete: nothing to restore
postRepo.onChange(() => {}, { events: ['restore'] });

// @ts-expect-error posts do not soft delete: there are no deleted documents
postRepo.onChange(() => {}, { withDeleted: true });

// A handler written apart, for one collection's changes, is accepted there…
const onPost = (change: ChangeOf<typeof posts>) => change.type;
postRepo.onChange(onPost);
// @ts-expect-error …and nowhere else
userRepo.onChange(onPost);

// The subscription is disposable.
async function scoped() {
	await using subscription = postRepo.onChange(() => {});
	const reason: 'closed' | 'invalidated' | 'failed' = await subscription.closed;
	return reason;
}
void scoped;

// An operator that would read the event rather than the document is refused.
// @ts-expect-error $expr
userRepo.onChange(() => {}, { filter: { $expr: { $eq: ['$age', 1] } } });
// @ts-expect-error $where
userRepo.onChange(() => {}, { filter: { $where: 'true' } });
// @ts-expect-error $text
userRepo.onChange(() => {}, { filter: { $text: { $search: 'ada' } } });
// @ts-expect-error $comment
userRepo.onChange(() => {}, { filter: { $comment: 'why' } });
// …and the logical ones still type their conditions.
userRepo.onChange(() => {}, {
	filter: { $or: [{ email: 'ada@example.com' }, { age: { $gt: 3 } }] },
});

// A resume token is a change's, and nothing else is taken for one.
userRepo.onChange((change) => {
	userRepo.onChange(() => {}, { startAfter: change.resumeToken });
	// @ts-expect-error an id is not a resume token
	userRepo.onChange(() => {}, { startAfter: change.id });
});
const saved: unknown = JSON.parse('{"_data":"826"}');
// @ts-expect-error a token read back has to be said to be one…
postRepo.onChange(() => {}, { startAfter: saved });
// …which is one cast.
postRepo.onChange(() => {}, { startAfter: saved as ResumeToken });
const where: ResumeToken | undefined = postRepo.onChange(() => {}).resumeToken;
void where;
