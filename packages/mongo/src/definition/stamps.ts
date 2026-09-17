import type { z } from 'zod';
import {
	type ActorField,
	actorFieldOf,
	type DeletedAtField,
	deletedAtField,
	type ObjectIdField,
	objectId,
	STAMP_FIELDS,
	type StampKind,
	type TimestampField,
	timestampField,
	type VersionField,
	versionField,
} from './fields';

/**
 * A stamp: off, on under its default name, or on under the name given.
 *
 * `false` and an absent option mean the same thing — the collection has no
 * such field, and the behaviour that reads it is off.
 */
export type NameOption = boolean | string;

/**
 * An option that covers more than one field: `true` for all of them under
 * their default names, or an object that says something about each.
 *
 * Inside that object, a key that is **absent** means on, under its default
 * name; `false` turns that one field off; a string renames it.
 */
export interface TimestampsOption {
	createdAt?: NameOption;
	updatedAt?: NameOption;
}

export type TimestampsChoice = boolean | TimestampsOption;

/** What the three `*By` fields take: a type for the actor, and their names. */
export interface ActorsOption {
	/** The actor's own Zod type. Default `objectId()`. */
	type?: z.ZodType;
	createdBy?: NameOption;
	updatedBy?: NameOption;
	deletedBy?: NameOption;
}

export type ActorsChoice = boolean | ActorsOption;

/** The soft-delete field, named. One field, but the same shape as the rest. */
export interface SoftDeleteOption {
	deletedAt?: NameOption;
}

export type SoftDeleteChoice = boolean | SoftDeleteOption;

/** The version field, named. */
export interface LockOption {
	version?: NameOption;
}

export type LockChoice = boolean | LockOption;

/**
 * The stamp options of `defineCollection`, for a config that is not generic.
 *
 * Every one of them reads the same way: `true` for its fields under their
 * default names, `false` for none, or an object naming them one by one. There
 * is no bare-string shorthand — one way to rename, not two.
 */
export interface StampOptions {
	timestamps?: TimestampsChoice;
	softDelete?: SoftDeleteChoice;
	optimisticLock?: LockChoice;
	actors?: ActorsChoice;
}

// --- the shape the options add, at the type level ----------------------

/**
 * One field's name inside a multi-field option. `Opt` is concrete by the
 * time this runs — it was inferred from the call — so reading a key that may
 * be absent is safe here, unlike an indexed access on a generic parameter.
 */
export type MemberNameOf<
	Opt,
	K extends string,
	Default extends string,
> = Opt extends true
	? Default
	: Opt extends { [P in K]: infer Given }
		? Given extends string
			? Given
			: Given extends true
				? Default
				: never
		: Opt extends object
			? Default
			: never;

/** `{ [Name]: Field }`, or nothing when the name resolved to `never`. */
export type FieldForName<Name, Field> = [Name] extends [never]
	? // biome-ignore lint/complexity/noBannedTypes: adding no field is the point
		{}
	: { [K in Name & string]: Field };

export type TimestampsShape<Opt> = FieldForName<
	MemberNameOf<Opt, 'createdAt', typeof STAMP_FIELDS.createdAt>,
	TimestampField
> &
	FieldForName<
		MemberNameOf<Opt, 'updatedAt', typeof STAMP_FIELDS.updatedAt>,
		TimestampField
	>;

export type SoftDeleteShape<Opt> = FieldForName<
	MemberNameOf<Opt, 'deletedAt', typeof STAMP_FIELDS.deletedAt>,
	DeletedAtField
>;

export type LockShape<Opt> = FieldForName<
	MemberNameOf<Opt, 'version', typeof STAMP_FIELDS.version>,
	VersionField
>;

/** The actor's field type: the one given, or an `ObjectId`. */
type ActorFieldOf<Opt> = Opt extends { type: infer Actor extends z.ZodType }
	? ActorField<Actor>
	: ActorField<ObjectIdField>;

/**
 * One `*By` field, under whatever name the option gave it.
 *
 * `MemberNameOf` is the same resolution the timestamps use, and the same one
 * `memberNameOf` performs at runtime — a second, weaker copy here is how
 * `{ createdBy: true }` came to add the field at runtime while the type left
 * it out. The default name is read from `STAMP_FIELDS`, as the runtime reads
 * it, rather than assumed to be the key.
 */
type ActorFieldFor<Opt, K extends StampKind> = FieldForName<
	MemberNameOf<Opt, K, (typeof STAMP_FIELDS)[K]>,
	ActorFieldOf<Opt>
>;

export type ActorsShape<Opt> = Opt extends false | undefined
	? // biome-ignore lint/complexity/noBannedTypes: adding no field is the point
		{}
	: ActorFieldFor<Opt, 'createdBy'> &
			ActorFieldFor<Opt, 'updatedBy'> &
			ActorFieldFor<Opt, 'deletedBy'>;

/** Everything the four options add to a schema. */
export type StampShape<TS, SD, OL, AC> = TimestampsShape<TS> &
	SoftDeleteShape<SD> &
	LockShape<OL> &
	ActorsShape<AC>;

/** A resolved name, at the type level: `false` when that stamp is off. */
export type NameFor<Name> = [Name] extends [never] ? false : Name & string;

/**
 * What each stamp is called here, as literals rather than `string`.
 *
 * A definition carries this so a type can read a field back under the name it
 * really has: `ActorOf` finds the actor under `openedBy` when the option
 * renamed it, instead of looking for a `createdBy` the documents do not have.
 * It is the type-level twin of what `resolveStampNames` computes.
 */
export type StampNamesOf<TS, SD, OL, AC> = {
	createdAt: NameFor<
		MemberNameOf<TS, 'createdAt', typeof STAMP_FIELDS.createdAt>
	>;
	updatedAt: NameFor<
		MemberNameOf<TS, 'updatedAt', typeof STAMP_FIELDS.updatedAt>
	>;
	deletedAt: NameFor<
		MemberNameOf<SD, 'deletedAt', typeof STAMP_FIELDS.deletedAt>
	>;
	version: NameFor<MemberNameOf<OL, 'version', typeof STAMP_FIELDS.version>>;
	createdBy: NameFor<
		MemberNameOf<AC, 'createdBy', typeof STAMP_FIELDS.createdBy>
	>;
	updatedBy: NameFor<
		MemberNameOf<AC, 'updatedBy', typeof STAMP_FIELDS.updatedBy>
	>;
	deletedBy: NameFor<
		MemberNameOf<AC, 'deletedBy', typeof STAMP_FIELDS.deletedBy>
	>;
};

// --- and at runtime ----------------------------------------------------

/**
 * What each stamp is called in this collection, or `false` when it has none.
 *
 * Every behaviour reads names from here: nothing else in the package may
 * write `'deletedAt'` or `'version'` as a literal, or renaming would be a
 * lie.
 */
export type StampNames = { [K in StampKind]: string | false };

/** The name a boolean-or-name option resolves to. */
function nameOf(
	option: NameOption | undefined,
	fallback: string,
): string | false {
	if (option === undefined || option === false) return false;
	if (option === true) return fallback;
	if (option === '') {
		throw new TypeError(
			`defineCollection: "" is not a field name. Pass true for "${fallback}", a name, or false.`,
		);
	}
	return option;
}

/**
 * The name one field of a multi-field option resolves to.
 *
 * Inside an object, a key that is **absent** means on, under its default
 * name: `{ type: z.string() }` asks for all three actor fields and only says
 * what they hold, and `{ createdAt: 'createdDate' }` renames one timestamp
 * and leaves the other alone. `false` is the one way to turn a field off.
 */
function memberNameOf(
	option:
		| TimestampsChoice
		| ActorsChoice
		| SoftDeleteChoice
		| LockChoice
		| undefined,
	kind: StampKind,
): string | false {
	if (option === undefined || option === false) return false;
	if (option === true) return STAMP_FIELDS[kind];
	const given = (option as Record<string, unknown>)[kind] as
		| NameOption
		| undefined;
	if (given === undefined) return STAMP_FIELDS[kind];
	return nameOf(given, STAMP_FIELDS[kind]);
}

/** Which field carries each meaning, for a config as it was written. */
export function resolveStampNames(options: StampOptions): StampNames {
	return {
		createdAt: memberNameOf(options.timestamps, 'createdAt'),
		updatedAt: memberNameOf(options.timestamps, 'updatedAt'),
		deletedAt: memberNameOf(options.softDelete, 'deletedAt'),
		version: memberNameOf(options.optimisticLock, 'version'),
		createdBy: memberNameOf(options.actors, 'createdBy'),
		updatedBy: memberNameOf(options.actors, 'updatedBy'),
		deletedBy: memberNameOf(options.actors, 'deletedBy'),
	};
}

/** The Zod fields those names stand for, ready to extend a schema with. */
export function stampShapeOf(
	options: StampOptions,
	names: StampNames,
): Record<string, z.ZodType> {
	const actor =
		typeof options.actors === 'object' && options.actors.type !== undefined
			? options.actors.type
			: objectId();
	const shape: Record<string, z.ZodType> = {};

	if (names.createdAt) shape[names.createdAt] = timestampField();
	if (names.updatedAt) shape[names.updatedAt] = timestampField();
	if (names.deletedAt) shape[names.deletedAt] = deletedAtField();
	if (names.version) shape[names.version] = versionField();
	if (names.createdBy) shape[names.createdBy] = actorFieldOf(actor);
	if (names.updatedBy) shape[names.updatedBy] = actorFieldOf(actor);
	if (names.deletedBy) shape[names.deletedBy] = actorFieldOf(actor);

	return shape;
}
