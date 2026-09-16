import type { IndexDescription, IndexDirection, ObjectId } from 'mongodb';
import type { z } from 'zod';

/** What MongoDB does with a document that fails the validator. */
export type ValidationAction = 'error' | 'warn';

/**
 * Which documents the validator applies to. `off` writes no validator at all;
 * `moderate` exempts documents that were already invalid from updates.
 */
export type ValidationLevel = 'off' | 'moderate' | 'strict';

export interface ValidationConfig {
	/** Default `'strict'`. */
	level?: ValidationLevel;
	/** Default `'error'`. `'warn'` logs and lets the write through. */
	action?: ValidationAction;
}

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

/** What `defineCollection` takes. */
export interface CollectionConfig<Schema extends z.ZodObject> {
	/** The collection's name on the server. */
	name: string;
	/**
	 * The documents, as they are stored: `z.output` is what a read gives back,
	 * `z.input` what a write takes. It must have an `_id`.
	 */
	schema: Schema;
	/** The indexes `sync` creates, keyed on the schema's fields. */
	indexes?: readonly CollectionIndex<z.output<Schema>>[];
	/** The `$jsonSchema` validator `sync` writes from the schema. */
	validation?: ValidationConfig;
}

/** A collection, as `defineCollection` returns it: frozen, with its defaults. */
export interface CollectionDefinition<
	Schema extends z.ZodObject = z.ZodObject,
> {
	readonly name: string;
	readonly schema: Schema;
	/** As the driver takes them: `sync` hands these straight to MongoDB. */
	readonly indexes: readonly IndexDescription[];
	readonly validation: Required<ValidationConfig>;
}

/** Any definition, whatever its documents. */
export type AnyCollectionDefinition = CollectionDefinition<any>;

/** The documents of a definition, as they are read back. */
export type DocumentOf<Def> = Def extends { schema: infer Schema }
	? Schema extends z.ZodType
		? z.output<Schema>
		: never
	: never;

/**
 * A document as a repository gives it back: the stored document, plus `id`.
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
 * Defines a collection: its name, the Zod schema of its documents, its
 * indexes, and how its validator is applied.
 *
 * The schema is the one source: it types every read and write, and `sync`
 * derives the collection's `$jsonSchema` validator from it.
 *
 * ```ts
 * export const users = defineCollection({
 * 	name: 'users',
 * 	schema: z.object({
 * 		_id: id(),
 * 		email: z.email(),
 * 		...timestamps(),
 * 		...softDelete(),
 * 	}),
 * 	indexes: [{ key: { email: 1 }, unique: true, name: 'users_email_unique' }],
 * });
 * ```
 */
export function defineCollection<Schema extends z.ZodObject>(
	config: CollectionConfig<Schema>,
): CollectionDefinition<Schema> {
	if (!('_id' in config.schema.shape)) {
		throw new TypeError(
			`defineCollection: "${config.name}"'s schema has no _id. Add ` +
				'`_id: id()`, which fills a new ObjectId on create, or declare the ' +
				'key your documents use.',
		);
	}
	return Object.freeze({
		...config,
		indexes: Object.freeze([...(config.indexes ?? [])]),
		validation: Object.freeze({
			level: config.validation?.level ?? 'strict',
			action: config.validation?.action ?? 'error',
		}),
	}) as CollectionDefinition<Schema>;
}

/** Which of the fields the repository knows about a definition's schema has. */
export function stampsOf(definition: AnyCollectionDefinition): {
	createdAt: boolean;
	updatedAt: boolean;
	deletedAt: boolean;
	version: boolean;
	createdBy: boolean;
	updatedBy: boolean;
	deletedBy: boolean;
} {
	const shape = definition.schema.shape as Record<string, unknown>;
	const has = (name: string) => name in shape;
	return {
		createdAt: has('createdAt'),
		updatedAt: has('updatedAt'),
		deletedAt: has('deletedAt'),
		version: has('version'),
		createdBy: has('createdBy'),
		updatedBy: has('updatedBy'),
		deletedBy: has('deletedBy'),
	};
}
