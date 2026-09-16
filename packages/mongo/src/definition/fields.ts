import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { isObjectId } from './object-id';

/**
 * An `ObjectId`, declared to MongoDB as `bsonType: 'objectId'`. JSON Schema
 * has no type for one, so the metadata is how the validator learns of it.
 */
export function objectId() {
	return z
		.custom<ObjectId>(isObjectId, { error: 'must be an ObjectId' })
		.meta({ bsonType: 'objectId' });
}

/**
 * `_id`, filled with a new `ObjectId` when a document is created: optional to
 * write, always there once read.
 */
export function id() {
	return objectId().default(() => new ObjectId());
}

/**
 * `createdAt` and `updatedAt`, filled on create. A collection sets `updatedAt`
 * on every update.
 */
export function timestamps() {
	return {
		createdAt: z.date().default(() => new Date()),
		updatedAt: z.date().default(() => new Date()),
	};
}

/**
 * `deletedAt`, `null` while the document is live. A collection on a collection
 * with it soft-deletes, and leaves deleted documents out of every read.
 */
export function softDelete() {
	return { deletedAt: z.date().nullable().default(null) };
}

/**
 * `version`, raised by one on every update. A collection with it takes
 * `expectedVersion` and throws `OptimisticLockError` when it no longer
 * matches.
 */
export function optimisticLock() {
	return { version: z.int().nonnegative().default(0) };
}

/**
 * `createdBy`, `updatedBy` and `deletedBy`, stamped from the actor a
 * collection was given with `as(actor)`. The actor's own type is the schema
 * passed in, an `ObjectId` by default.
 */
export function actors<Actor extends z.ZodType = ReturnType<typeof objectId>>(
	actor: Actor = objectId() as unknown as Actor,
) {
	return {
		createdBy: actor.nullable().default(null),
		updatedBy: actor.nullable().default(null),
		deletedBy: actor.nullable().default(null),
	};
}

/** The fields the collection gives a meaning to, by name. */
export const STAMP_FIELDS = {
	id: '_id',
	createdAt: 'createdAt',
	updatedAt: 'updatedAt',
	deletedAt: 'deletedAt',
	version: 'version',
	createdBy: 'createdBy',
	updatedBy: 'updatedBy',
	deletedBy: 'deletedBy',
} as const;
