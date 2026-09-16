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
 * The default name of each field a collection gives a meaning to. An option
 * of `defineCollection` that is `true` adds the field under the name here;
 * one given a string adds it under that name instead.
 */
export const STAMP_FIELDS = {
	createdAt: 'createdAt',
	updatedAt: 'updatedAt',
	deletedAt: 'deletedAt',
	version: 'version',
	createdBy: 'createdBy',
	updatedBy: 'updatedBy',
	deletedBy: 'deletedBy',
} as const;

/** One of the meanings a collection knows, whatever the field is called. */
export type StampKind = keyof typeof STAMP_FIELDS;

// --- the fields themselves --------------------------------------------
//
// One builder per field. `defineCollection`'s options are what *activate* a
// stamp; these are the fields those options add, declared once, and they are
// also how a schema declares such a field on its own — with no behaviour
// attached, which is sometimes exactly what is wanted.

/** A timestamp, filled on create. `updatedAt` is set again on every update. */
export function timestampField() {
	return z.date().default(() => new Date());
}

/** A soft-delete field: `null` while the document is live. */
export function deletedAtField() {
	return z.date().nullable().default(null);
}

/** A version field: raised by one on every update. */
export function versionField() {
	return z.int().nonnegative().default(0);
}

/** An actor reference, `null` until something stamps it. */
export function actorFieldOf<Actor extends z.ZodType>(actor: Actor) {
	return actor.nullable().default(null);
}

export type TimestampField = ReturnType<typeof timestampField>;
export type DeletedAtField = ReturnType<typeof deletedAtField>;
export type VersionField = ReturnType<typeof versionField>;
export type ActorField<Actor extends z.ZodType> = ReturnType<
	typeof actorFieldOf<Actor>
>;
