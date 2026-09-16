import type { IndexDescription, IndexDirection, ObjectId } from 'mongodb';
import type { z } from 'zod';
import { registerCollection } from '../sync/registry';
import type { MongoCollectionOptions } from './collection-options';
import {
	type ActorsChoice,
	type LockChoice,
	resolveStampNames,
	type SoftDeleteChoice,
	type StampNames,
	type StampNamesOf,
	type StampShape,
	stampShapeOf,
	type TimestampsChoice,
} from './stamps';
import { resolveValidation, type ValidationConfig } from './validation';

/**
 * What an index may be keyed on: a field of the documents, which an editor
 * completes, or a path into one — `{ 'address.city': 1 }` is how MongoDB
 * indexes a nested field, and there is no way to check the tail of a path
 * against a schema without rejecting the paths Mongo allows.
 */
export type IndexKey<Doc> =
	| {
			[Field in
				| (keyof Doc & string)
				| `${keyof Doc & string}.${string}`]?: IndexDirection;
	  }
	// The driver takes a `Map` too, and an index read back off the server comes
	// as one: refusing it here would refuse a definition built from a live one.
	| Map<string, IndexDirection>;

/**
 * An index, keyed on the schema's own fields. Everything else — `unique`,
 * `name`, `collation`, `partialFilterExpression`, the TTL — is the driver's
 * `IndexDescription`, unchanged.
 */
export interface CollectionIndex<Doc> extends Omit<IndexDescription, 'key'> {
	key: IndexKey<Doc>;
}

/** The schema a config declares, plus whatever its stamp options add. */
export type StampedSchema<
	Shape extends z.ZodRawShape,
	TS,
	SD,
	OL,
	AC,
> = z.ZodObject<Shape & StampShape<TS, SD, OL, AC>>;

/**
 * What `defineCollection` takes.
 *
 * The four stamp options add their fields **to the schema**: the collection's
 * documents, its TypeScript type and its `$jsonSchema` validator all carry
 * them, because a validator refuses any property the schema does not declare.
 * Each is off, `true` for the default name, or a name of its own.
 */
export interface CollectionConfig<
	Shape extends z.ZodRawShape = z.ZodRawShape,
	TS extends TimestampsChoice = false,
	SD extends SoftDeleteChoice = false,
	OL extends LockChoice = false,
	AC extends ActorsChoice = false,
> {
	/** The collection's name on the server. */
	name: string;
	/**
	 * The documents, as they are stored: `z.output` is what a read gives back,
	 * `z.input` what a write takes. It must have an `_id`.
	 */
	schema: z.ZodObject<Shape>;
	/**
	 * The indexes `sync` creates, keyed on the fields — the options' included.
	 *
	 * `NoInfer` is what makes that possible: this property *uses* the four
	 * option parameters, and without it they would have to be resolved in
	 * order to check it, while being inferred from the very object it belongs
	 * to. TypeScript gives up on that circle and falls back to the defaults,
	 * which makes every option read as absent — `timestamps: true` is then
	 * reported as an unknown property, on a config that has no indexes at all.
	 */
	indexes?: readonly CollectionIndex<
		NoInfer<z.output<StampedSchema<Shape, TS, SD, OL, AC>>>
	>[];
	/** The `$jsonSchema` validator `sync` writes from the schema. */
	validation?: ValidationConfig;
	/**
	 * MongoDB's own options for the collection — capped, time-series,
	 * collation, clustered — keyed on the schema's fields where they name one.
	 *
	 * Most of these are fixed at creation. `sync` creates the collection with
	 * them, changes the few `collMod` accepts, and throws on the rest rather
	 * than leave a collection quietly unlike its definition.
	 */
	options?: MongoCollectionOptions<
		NoInfer<keyof z.output<StampedSchema<Shape, TS, SD, OL, AC>> & string>
	>;
	/**
	 * `createdAt` and `updatedAt`: `true` for both, or
	 * `{ createdAt: 'openedAt', updatedAt: false }` to name or drop each one.
	 */
	timestamps?: TS;
	/** `deletedAt`: `delete` then writes it instead of removing the document. */
	softDelete?: SD;
	/** `version`: every update raises it, and `expectedVersion` checks it. */
	optimisticLock?: OL;
	/** `createdBy`, `updatedBy` and `deletedBy`, stamped from `as(actor)`. */
	actors?: AC;
}

/** A collection, as `defineCollection` returns it: frozen, with its defaults. */
export interface CollectionDefinition<
	Schema extends z.ZodObject = z.ZodObject,
	Names extends StampNames = StampNames,
> {
	readonly name: string;
	/** The declared schema, extended with whatever the stamp options added. */
	readonly schema: Schema;
	/** As the driver takes them: `sync` hands these straight to MongoDB. */
	readonly indexes: readonly IndexDescription[];
	readonly validation: Required<ValidationConfig>;
	/** MongoDB's own options, as `sync` creates the collection with them. */
	readonly options: MongoCollectionOptions;
	/**
	 * What each stamp is called here, or `false` when the collection has none.
	 * Every behaviour reads its field name from this, so a renamed stamp is
	 * renamed everywhere.
	 *
	 * The names are literals, not `string`: that is what lets `ActorOf` read
	 * the actor's type back under the name the option gave it.
	 */
	readonly stamps: Names;
}

/** Any definition, whatever its documents. */
export type AnyCollectionDefinition = CollectionDefinition<any, StampNames>;

/** The documents of a definition, as they are read back. */
export type DocumentOf<Def> = Def extends { schema: infer Schema }
	? Schema extends z.ZodType
		? z.output<Schema>
		: never
	: never;

/**
 * A document as a collection gives it back: the stored document, plus `id`.
 *
 * `id` is `_id` as a string, computed rather than stored — the collection
 * holds `_id` alone. It is enumerable, so `JSON.stringify` and a spread carry
 * it, which is what makes a document ready to return from an API; it is not
 * part of `DocumentOf`, so a filter or a patch cannot be keyed on it, because
 * the server would match nothing.
 */
export type ReadDocumentOf<Def> = DocumentOf<Def> & { readonly id: string };

/** What a write takes: the documents before their defaults are filled. */
export type NewDocumentOf<Def> = Def extends { schema: infer Schema }
	? Schema extends z.ZodType
		? z.input<Schema>
		: never
	: never;

/** The type of `_id`. */
export type IdOf<Def> =
	DocumentOf<Def> extends { _id: infer Id } ? Id : ObjectId;

/** A field of the documents, as a top-level key. */
export type FieldOf<Def> = keyof DocumentOf<Def> & string;

/**
 * Defines a collection: its name, the Zod schema of its documents, the stamps
 * it keeps, its indexes, and how its validator is applied.
 *
 * The schema is the one source: it types every read and write, and `sync`
 * derives the collection's `$jsonSchema` validator from it. The stamp options
 * add their fields to it, so a renamed stamp is renamed in the type, in the
 * validator and in every behaviour that reads it.
 *
 * ```ts
 * export const users = defineCollection({
 * 	name: 'users',
 * 	schema: z.object({ _id: id(), email: z.email() }),
 * 	timestamps: true,
 * 	softDelete: { deletedAt: 'removedAt' },
 * 	optimisticLock: true,
 * 	actors: { type: objectId() },
 * 	indexes: [{ key: { email: 1 }, unique: true, name: 'users_email_unique' }],
 * });
 * ```
 */
export function defineCollection<
	Shape extends z.ZodRawShape,
	const TS extends TimestampsChoice = false,
	const SD extends SoftDeleteChoice = false,
	const OL extends LockChoice = false,
	const AC extends ActorsChoice = false,
>(
	config: CollectionConfig<Shape, TS, SD, OL, AC>,
): CollectionDefinition<
	StampedSchema<Shape, TS, SD, OL, AC>,
	StampNamesOf<TS, SD, OL, AC>
> {
	if (!('_id' in config.schema.shape)) {
		throw new TypeError(
			`defineCollection: "${config.name}"'s schema has no _id. Add ` +
				'`_id: id()`, which fills a new ObjectId on create, or declare the ' +
				'key your documents use.',
		);
	}

	const stamps = resolveStampNames(config);
	const added = stampShapeOf(config, stamps);

	for (const field of Object.keys(added)) {
		if (field in config.schema.shape) {
			throw new TypeError(
				`defineCollection: "${config.name}" declares "${field}" in its schema ` +
					'and asks for it again as an option. Keep one: the option, or the ' +
					'field. Spreading the helper and setting the option both add it.',
			);
		}
	}

	const schema =
		Object.keys(added).length > 0 ? config.schema.extend(added) : config.schema;

	const definition = Object.freeze({
		name: config.name,
		schema,
		indexes: Object.freeze([...(config.indexes ?? [])]),
		validation: Object.freeze(
			resolveValidation(
				config.name,
				config.validation,
				config.options?.timeseries !== undefined,
			),
		),
		options: Object.freeze({ ...config.options }),
		stamps: Object.freeze(stamps),
	}) as CollectionDefinition<
		StampedSchema<Shape, TS, SD, OL, AC>,
		StampNamesOf<TS, SD, OL, AC>
	>;

	// Defining a collection is what registers it, so `syncAll` needs no list.
	registerCollection(definition);
	return definition;
}
