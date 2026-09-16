// What the stamp options do to the documents' type, checked by `tsc` and
// never run. Each `@ts-expect-error` must fire: one that stops catching
// anything fails the typecheck, which is how a hole shows up here.

import { z } from 'zod';
import type { ActorOf } from '../../src/collection/types';
import {
	type DocumentOf,
	defineCollection,
	type NewDocumentOf,
} from '../../src/definition/define-collection';
import { id, type objectId } from '../../src/definition/fields';

type Assert<T extends true> = T;
type Equals<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

// --- every option on, one of them renamed -----------------------------

const users = defineCollection({
	name: 'users',
	schema: z.object({ _id: id(), email: z.string() }),
	timestamps: true,
	softDelete: { deletedAt: 'removedAt' },
	optimisticLock: true,
	actors: { type: z.string() },
});

type User = DocumentOf<typeof users>;

type _renamedField = Assert<Equals<User['removedAt'], Date | null>>;
type _createdAt = Assert<Equals<User['createdAt'], Date>>;
type _updatedAt = Assert<Equals<User['updatedAt'], Date>>;
type _version = Assert<Equals<User['version'], number>>;
// The actor's own type is the one the option carried, not an ObjectId.
type _actor = Assert<Equals<User['createdBy'], string | null>>;
type _ownField = Assert<Equals<User['email'], string>>;

// The field moved: it was renamed, not added under both names.
// @ts-expect-error `deletedAt` is `removedAt` here
type _noDefaultName = User['deletedAt'];

// A stamp has a default, so a write may leave it out.
const _write: NewDocumentOf<typeof users> = { email: 'ada@example.com' };

// --- no options at all ------------------------------------------------

const logs = defineCollection({
	name: 'logs',
	schema: z.object({ _id: id(), message: z.string() }),
});

type Log = DocumentOf<typeof logs>;

// Nothing is injected, and no index signature is left behind: an option
// that is absent must read as absent, not as the constraint's type.
type _bareKeys = Assert<Equals<keyof Log, '_id' | 'message'>>;

// --- some on, some explicitly off -------------------------------------

const events = defineCollection({
	name: 'events',
	schema: z.object({ _id: id() }),
	timestamps: true,
	softDelete: false,
});

type Event = DocumentOf<typeof events>;

type _partialKeys = Assert<
	Equals<keyof Event, '_id' | 'createdAt' | 'updatedAt'>
>;

// --- one actor field turned off on its own ----------------------------

const tickets = defineCollection({
	name: 'tickets',
	schema: z.object({ _id: id() }),
	actors: { createdBy: 'openedBy', deletedBy: false },
});

type Ticket = DocumentOf<typeof tickets>;

type _actorRenamed = Assert<
	Equals<Ticket['openedBy'], ReturnType<typeof objectId>['_output'] | null>
>;
// An absent key means on under its default name; only `false` turns one off.
type _actorKept = Assert<
	Equals<keyof Ticket, '_id' | 'openedBy' | 'updatedBy'>
>;

// --- who `as()` takes -------------------------------------------------

// The actor's type is read under the name the option gave the field. Reading
// it under the default `createdBy` resolved to `never` here, which made
// `as()` uncallable on a collection that does have an actor.
type _actorRenamedType = Assert<
	Equals<ActorOf<typeof tickets>, ReturnType<typeof objectId>['_output']>
>;
// And it is the actor's own type when the option carried one.
type _actorOwnType = Assert<Equals<ActorOf<typeof users>, string>>;
// A collection with no actor field has none to stamp.
type _noActor = Assert<Equals<ActorOf<typeof logs>, never>>;

// --- the collection options are keyed on the schema too ---------------

defineCollection({
	name: 'readings',
	schema: z.object({ _id: id(), at: z.date(), sensor: z.string() }),
	options: { timeseries: { timeField: 'at', metaField: 'sensor' } },
});

defineCollection({
	name: 'readings',
	schema: z.object({ _id: id(), at: z.date() }),
	// @ts-expect-error there is no `recordedAt` to key the series on
	options: { timeseries: { timeField: 'recordedAt' } },
});

// A stamp the options added is a field like any other, series included.
defineCollection({
	name: 'readings',
	schema: z.object({ _id: id() }),
	timestamps: { createdAt: 'recordedAt' },
	options: { timeseries: { timeField: 'recordedAt' } },
});

defineCollection({
	name: 'audit',
	schema: z.object({ _id: id() }),
	// @ts-expect-error a capped collection needs a size; MongoDB refuses it without
	options: { capped: {} },
});

// --- what must not compile --------------------------------------------

defineCollection({
	name: 'bad',
	schema: z.object({ _id: id() }),
	// @ts-expect-error a stamp is a boolean or a name, not a number
	softDelete: 123,
});

defineCollection({
	name: 'bad',
	schema: z.object({ _id: id(), rank: z.number() }),
	timestamps: true,
	// @ts-expect-error "nope" is no field of these documents
	indexes: [{ key: { nope: 1 } }],
});

defineCollection({
	name: 'bad',
	schema: z.object({ _id: id() }),
	softDelete: { deletedAt: 'removedAt' },
	// @ts-expect-error the field is called `removedAt` here, not `deletedAt`
	indexes: [{ key: { deletedAt: 1 } }],
});

// An index on a field an option added is fine, which is the whole point of
// typing `indexes` against the extended documents.
defineCollection({
	name: 'good',
	schema: z.object({ _id: id() }),
	timestamps: true,
	indexes: [{ key: { createdAt: -1 } }],
});
