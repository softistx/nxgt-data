import type { ClientSession, Db, Document } from 'mongodb';
import type { z } from 'zod';
import {
	type AnyCollectionDefinition,
	type CollectionDefinition,
	stampsOf,
} from '../definition/define-collection';
import {
	DataError,
	NotFoundError,
	OptimisticLockError,
} from '../errors/data-error';
import { toDataError } from '../errors/to-data-error';
import { decodeCursor, encodeCursor } from '../pagination/cursor';
import {
	type CursorPage,
	cursorLimit,
	DEFAULT_MAX_PAGE_SIZE,
	type Page,
	pageWindow,
	toPage,
} from '../pagination/page';
import { type SyncOptions, syncCollection } from '../sync/sync-collection';
import type { OrderDirection, Repository, RepositoryOptions } from './types';

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Does this patch speak in MongoDB's operators rather than in fields? */
function isUpdateFilter(patch: Fields): boolean {
	return Object.keys(patch).some((key) => key.startsWith('$'));
}

/** `a` and `b`, without letting one's `$or` swallow the other's. */
function mergeFilters(a: Fields | undefined, b: Fields | undefined): Fields {
	const left = a && Object.keys(a).length > 0 ? a : undefined;
	const right = b && Object.keys(b).length > 0 ? b : undefined;
	if (!left) return right ?? {};
	if (!right) return left;
	return { $and: [left, right] };
}

/**
 * A repository over one collection: typed reads and writes by `_id` or by
 * filter, pagination, soft delete, optimistic locking, audit stamps, and
 * MongoDB errors turned into this package's.
 *
 * ```ts
 * const users = createRepository(db, usersCollection);
 * const ada = await users.create({ email: 'ada@example.com' });
 * await users.update(ada._id, { name: 'Ada' }, { expectedVersion: ada.version });
 * ```
 *
 * Every operation runs in the repository's session, which `with(session)`
 * sets: MongoDB has no ambient session, so a write inside a transaction that
 * was not given one is not part of it and is not rolled back.
 */
export function createRepository<Schema extends z.ZodObject>(
	db: Db,
	definition: CollectionDefinition<Schema>,
	options: RepositoryOptions = {},
): Repository<CollectionDefinition<Schema>> {
	return build(db, definition, options) as unknown as Repository<
		CollectionDefinition<Schema>
	>;
}

function build(
	db: Db,
	definition: AnyCollectionDefinition,
	options: RepositoryOptions,
) {
	const name = definition.name;
	// The driver types a collection by its documents; this body works on any
	// collection, and the public type above is what callers see.
	const collection = db.collection<any>(name);
	const shape = definition.schema.shape as Record<string, z.ZodType>;
	const stamps = stampsOf(definition);
	const session = options.session;
	const actor = options.actor;
	const maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;
	const parses = (options.validate ?? 'parse') === 'parse';
	const softDeletes = options.softDelete ?? stamps.deletedAt;
	const touches = options.touchUpdatedAt ?? stamps.updatedAt;
	const locks = options.optimisticLock ?? stamps.version;

	if (options.softDelete === true && !stamps.deletedAt) {
		throw new TypeError(
			`createRepository: softDelete needs a "deletedAt" field, and "${name}" has none`,
		);
	}
	if (options.optimisticLock === true && !stamps.version) {
		throw new TypeError(
			`createRepository: optimisticLock needs a "version" field, and "${name}" has none`,
		);
	}

	const run = async <T>(fn: () => Promise<T>): Promise<T> => {
		try {
			return await fn();
		} catch (error) {
			throw toDataError(error, { collection: name });
		}
	};

	const sessionOption = session ? { session } : {};

	/** The filter that leaves soft-deleted documents out. */
	const live = (withDeleted?: boolean): Fields | undefined =>
		softDeletes && !withDeleted ? { deletedAt: null } : undefined;

	const scoped = (filter: unknown, withDeleted?: boolean): Fields =>
		mergeFilters(isRecord(filter) ? filter : undefined, live(withDeleted));

	const notFound = (id: unknown) =>
		new NotFoundError(`No document in "${name}" with _id ${String(id)}`, {
			collection: name,
			id,
		});

	const requireFilter = (method: string, filter: unknown): void => {
		if (!isRecord(filter) || Object.keys(filter).length === 0) {
			throw new TypeError(
				`${method} needs a filter. Pass \`{ _id: { $exists: true } }\` to target every document of "${name}".`,
			);
		}
	};

	/** The document to insert: checked against the schema, defaults filled. */
	const toDocument = (values: unknown): Fields => {
		const stamped: Fields = { ...(values as Fields) };
		if (actor !== undefined) {
			if (stamps.createdBy && stamped.createdBy === undefined) {
				stamped.createdBy = actor;
			}
			if (stamps.updatedBy && stamped.updatedBy === undefined) {
				stamped.updatedBy = actor;
			}
		}
		return parses ? (definition.schema.parse(stamped) as Fields) : stamped;
	};

	/**
	 * The update to send: a patch of fields becomes `$set`, checked field by
	 * field against the schema, with the stamps this repository keeps. A patch
	 * that already speaks in operators is sent as it is, with the stamps added.
	 */
	const toUpdate = (patch: unknown): Fields => {
		if (!isRecord(patch)) {
			throw new TypeError(
				`update: expected the document's fields or MongoDB's operators, not ${String(patch)}`,
			);
		}
		const update: Fields = isUpdateFilter(patch) ? { ...patch } : {};
		const set: Fields = isRecord(update.$set) ? { ...update.$set } : {};

		if (!isUpdateFilter(patch)) {
			for (const [field, value] of Object.entries(patch)) {
				if (value === undefined) continue;
				const schema = shape[field];
				if (!schema) {
					throw new TypeError(
						`update: "${name}" has no field "${field}" in its schema`,
					);
				}
				set[field] = parses ? schema.parse(value) : value;
			}
		}

		if (touches && set.updatedAt === undefined) set.updatedAt = new Date();
		if (
			actor !== undefined &&
			stamps.updatedBy &&
			set.updatedBy === undefined
		) {
			set.updatedBy = actor;
		}
		if (Object.keys(set).length > 0) update.$set = set;

		if (locks) {
			const inc = isRecord(update.$inc) ? { ...update.$inc } : {};
			inc.version = (inc.version as number | undefined) ?? 1;
			update.$inc = inc;
		}
		return update;
	};

	const findOne = async (filter: Fields, projection?: unknown) =>
		run(async () =>
			collection.findOne(filter, {
				...sessionOption,
				...(projection ? { projection } : {}),
			}),
		);

	async function findById(id: unknown, opts: { withDeleted?: boolean } = {}) {
		const found = await findOne(scoped({ _id: id }, opts.withDeleted));
		return found ?? undefined;
	}

	async function getById(id: unknown, opts: { withDeleted?: boolean } = {}) {
		const found = await findById(id, opts);
		if (!found) throw notFound(id);
		return found;
	}

	async function findMany(opts: Fields = {}): Promise<Fields[]> {
		return run(async () => {
			let cursor = collection.find(
				scoped(opts.filter, opts.withDeleted as boolean | undefined),
				{
					...sessionOption,
					...(opts.projection ? { projection: opts.projection } : {}),
				},
			);
			if (opts.sort !== undefined) cursor = cursor.sort(opts.sort as never);
			if (opts.skip !== undefined) cursor = cursor.skip(opts.skip as number);
			if (opts.limit !== undefined) cursor = cursor.limit(opts.limit as number);
			return cursor.toArray();
		});
	}

	async function countDocuments(
		filter?: unknown,
		opts: { withDeleted?: boolean } = {},
	) {
		return run(async () =>
			collection.countDocuments(scoped(filter, opts.withDeleted), {
				...sessionOption,
			}),
		);
	}

	/**
	 * `findOneAndUpdate` answers `null` for a document that is not there, one
	 * that is soft-deleted, and one whose version moved. Only a second read
	 * tells them apart.
	 */
	async function updatedOrThrow(
		id: unknown,
		filter: Fields,
		update: Fields,
		expectedVersion: number | undefined,
	): Promise<Fields> {
		const updated = await run(async () =>
			collection.findOneAndUpdate(filter, update, {
				...sessionOption,
				returnDocument: 'after',
			}),
		);
		if (updated) return updated as Fields;

		if (expectedVersion !== undefined) {
			const current = await findOne({ _id: id });
			if (current) {
				throw new OptimisticLockError(
					`Document ${String(id)} of "${name}" is at version ${String(
						current.version,
					)}, not ${expectedVersion}: it changed since it was read`,
					{
						collection: name,
						id,
						expectedVersion,
						actualVersion:
							typeof current.version === 'number' ? current.version : undefined,
					},
				);
			}
		}
		throw notFound(id);
	}

	async function hardDelete(id: unknown): Promise<Fields> {
		const deleted = await run(async () =>
			collection.findOneAndDelete({ _id: id }, { ...sessionOption }),
		);
		if (!deleted) throw notFound(id);
		return deleted as Fields;
	}

	async function hardDeleteMany(filter: unknown): Promise<number> {
		requireFilter('hardDeleteMany', filter);
		return run(async () => {
			const result = await collection.deleteMany(filter as Fields, {
				...sessionOption,
			});
			return result.deletedCount;
		});
	}

	const repository = {
		definition,
		db,
		collection,
		session,

		with: (other: ClientSession | undefined) =>
			build(db, definition, { ...options, session: other }),
		as: (who: unknown) => build(db, definition, { ...options, actor: who }),
		sync: (syncOptions: SyncOptions = {}) =>
			syncCollection(db, definition, { ...sessionOption, ...syncOptions }),

		findById,
		getById,

		async findFirst(filter?: unknown, opts: Fields = {}) {
			const [first] = await findMany({ ...opts, filter, limit: 1 });
			return first;
		},

		findMany,

		async create(values: unknown) {
			const document = toDocument(values);
			return run(async () => {
				await collection.insertOne(document as Document, { ...sessionOption });
				return document;
			});
		},

		async createMany(values: readonly unknown[]) {
			if (values.length === 0) return [];
			const documents = values.map(toDocument);
			return run(async () => {
				await collection.insertMany(documents as Document[], {
					...sessionOption,
				});
				return documents;
			});
		},

		async update(id: unknown, patch: unknown, opts: Fields = {}) {
			const expectedVersion = opts.expectedVersion as number | undefined;
			if (expectedVersion !== undefined && !locks) {
				throw new TypeError(
					`update: expectedVersion needs a "version" field, and "${name}" has none`,
				);
			}
			const update = toUpdate(patch);
			const filter = mergeFilters(
				{
					_id: id,
					...(expectedVersion === undefined
						? {}
						: { version: expectedVersion }),
				},
				live(),
			);
			return updatedOrThrow(id, filter, update, expectedVersion);
		},

		async updateMany(filter: unknown, patch: unknown) {
			requireFilter('updateMany', filter);
			const update = toUpdate(patch);
			return run(async () => {
				const result = await collection.updateMany(scoped(filter), update, {
					...sessionOption,
				});
				return result.modifiedCount;
			});
		},

		async delete(id: unknown) {
			if (!softDeletes) return hardDelete(id);
			const set: Fields = { deletedAt: new Date() };
			if (actor !== undefined && stamps.deletedBy) set.deletedBy = actor;
			const update: Fields = { $set: set };
			if (locks) update.$inc = { version: 1 };
			return updatedOrThrow(
				id,
				mergeFilters({ _id: id }, live()),
				update,
				undefined,
			);
		},

		async deleteMany(filter: unknown) {
			requireFilter('deleteMany', filter);
			if (!softDeletes) return hardDeleteMany(filter);
			const set: Fields = { deletedAt: new Date() };
			if (actor !== undefined && stamps.deletedBy) set.deletedBy = actor;
			const update: Fields = { $set: set };
			if (locks) update.$inc = { version: 1 };
			return run(async () => {
				const result = await collection.updateMany(scoped(filter), update, {
					...sessionOption,
				});
				return result.modifiedCount;
			});
		},

		hardDelete,
		hardDeleteMany,

		async restore(id: unknown) {
			if (!stamps.deletedAt) {
				throw new TypeError(`restore: "${name}" has no soft delete`);
			}
			const set: Fields = { deletedAt: null };
			if (stamps.deletedBy) set.deletedBy = null;
			if (touches) set.updatedAt = new Date();
			const update: Fields = { $set: set };
			if (locks) update.$inc = { version: 1 };
			return updatedOrThrow(id, { _id: id }, update, undefined);
		},

		count: countDocuments,

		async exists(filter: unknown, opts: { withDeleted?: boolean } = {}) {
			const found = await findOne(scoped(filter, opts.withDeleted), { _id: 1 });
			return found !== null && found !== undefined;
		},

		async paginate(opts: Fields = {}): Promise<Page<Fields>> {
			const window = pageWindow(opts, maxPageSize);
			const [items, total] = await Promise.all([
				findMany({
					filter: opts.filter,
					sort: opts.sort ?? { _id: 1 },
					limit: window.limit,
					skip: window.skip,
					withDeleted: opts.withDeleted,
				}),
				countDocuments(opts.filter, {
					withDeleted: opts.withDeleted as boolean | undefined,
				}),
			]);
			return toPage(items, total, window);
		},

		async paginateByCursor(opts: Fields = {}): Promise<CursorPage<Fields>> {
			const sortField = (opts.orderBy as string | undefined) ?? '_id';
			if (!shape[sortField] && sortField !== '_id') {
				throw new TypeError(
					`paginateByCursor: "${name}" has no field "${sortField}" in its schema`,
				);
			}
			const direction = (opts.direction as OrderDirection | undefined) ?? 'asc';
			const fields = sortField === '_id' ? ['_id'] : [sortField, '_id'];
			const cursorKey = `${sortField}:${direction}`;
			const limit = cursorLimit(opts.limit as number | undefined, maxPageSize);
			const past = direction === 'asc' ? '$gt' : '$lt';

			let after: Fields | undefined;
			if (opts.after) {
				const { values } = decodeCursor(opts.after as string, cursorKey);
				if (values.length !== fields.length) {
					throw new DataError(
						`Invalid cursor: expected ${fields.length} value(s), got ${values.length}`,
						{ collection: name },
					);
				}
				// `a > x OR (a = x AND b > y)`, the keyset of the ordering.
				after = {
					$or: fields.map((field, index) => ({
						...Object.fromEntries(
							fields
								.slice(0, index)
								.map((previous, i) => [previous, values[i]]),
						),
						[field]: { [past]: values[index] },
					})),
				};
			}

			const sort = Object.fromEntries(
				fields.map((field) => [field, direction === 'asc' ? 1 : -1]),
			);
			const documents = await findMany({
				filter: mergeFilters(
					isRecord(opts.filter) ? opts.filter : undefined,
					after,
				),
				sort,
				limit: limit + 1,
				withDeleted: opts.withDeleted,
			});

			const items = documents.slice(0, limit);
			const last = items.at(-1);
			if (documents.length <= limit || !last) {
				return { items, nextCursor: null };
			}

			const values = fields.map((field) => {
				const value = last[field];
				if (value === null || value === undefined) {
					throw new TypeError(
						`paginateByCursor: "${field}" is null in a document of "${name}". ` +
							'Page along a field every document has.',
					);
				}
				return value;
			});
			return { items, nextCursor: encodeCursor({ key: cursorKey, values }) };
		},
	};

	return repository;
}
