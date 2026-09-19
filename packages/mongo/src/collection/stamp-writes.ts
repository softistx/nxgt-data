import type { CollectionContext } from './context';
import { type Fields, isRecord } from './filters';

/**
 * What a write may say about the stamps: the policy `toDocument` and
 * `toUpdate` apply before anything is sent. A create may give the
 * timestamps, an update `updatedAt` and the version it expects; the rest is
 * the collection's to write.
 */

/**
 * The stamps only the collection writes, by their names here: the
 * soft-delete field, the version and the actors.
 */
export function keptByCollection(ctx: CollectionContext): string[] {
	const { deletedAt, version, createdBy, updatedBy, deletedBy } = ctx.stamps;
	return [deletedAt, version, createdBy, updatedBy, deletedBy].filter(
		(name): name is string => name !== false,
	);
}

function refused(ctx: CollectionContext, method: string, name: string) {
	return new TypeError(
		`${method}: "${name}" is kept by "${ctx.name}" itself and cannot be ` +
			'written. `raw` is the way to set it by hand.',
	);
}

/** Refuses a new document that gives a stamp the collection keeps. */
export function refuseKeptOnCreate(
	ctx: CollectionContext,
	document: Fields,
): void {
	for (const name of keptByCollection(ctx)) {
		if (document[name] !== undefined) throw refused(ctx, 'create', name);
	}
}

/**
 * The stamps a document without parsing still needs: they are the
 * collection's to write, so `validate: 'off'` leaves no caller able to.
 */
export function fillStamps(ctx: CollectionContext, document: Fields): void {
	for (const name of Object.values(ctx.stamps)) {
		const field = name === false ? undefined : ctx.shape[name];
		if (name !== false && field && document[name] === undefined) {
			document[name] = field.parse(undefined);
		}
	}
}

/**
 * The version a patch expects, taken out of it: under the version field's
 * name it is a condition, not a value to write.
 */
export function expectedVersionOf(
	ctx: CollectionContext,
	method: string,
	patch: Fields,
): number | undefined {
	const field = ctx.stamps.version;
	if (!field || patch[field] === undefined) return undefined;
	const expected = patch[field];
	delete patch[field];
	if (method !== 'update') throw refused(ctx, method, field);
	if (!ctx.locks) {
		throw new TypeError(
			`update: "${field}" is an expected version, and "${ctx.name}" is ` +
				'used here without its optimistic lock',
		);
	}
	if (
		typeof expected !== 'number' ||
		!Number.isInteger(expected) ||
		expected < 0
	) {
		throw new TypeError(
			`update: the expected "${field}" must be a whole number, not ${String(expected)}`,
		);
	}
	return expected;
}

/** Operators that take a field away rather than give it a value. */
const REMOVING = new Set(['$unset', '$rename']);

const head = (path: string) => path.split('.')[0] as string;

interface Touched {
	/** Every top-level field the patch writes, through an operator or not. */
	written: Set<string>;
	/** The ones it removes or renames away. */
	removed: Set<string>;
}

/**
 * What a patch touches. `$rename` writes the field it names as a value as
 * well as the one it names as a key.
 */
function touchedBy(patch: Fields): Touched {
	const written = new Set<string>();
	const removed = new Set<string>();
	for (const [key, value] of Object.entries(patch)) {
		if (!key.startsWith('$') || !isRecord(value)) {
			written.add(head(key));
			continue;
		}
		for (const [path, target] of Object.entries(value)) {
			written.add(head(path));
			if (REMOVING.has(key)) removed.add(head(path));
			if (key === '$rename') {
				written.add(head(String(target)));
				removed.add(head(String(target)));
			}
		}
	}
	return { written, removed };
}

/**
 * Refuses a patch that writes a stamp the collection keeps, or takes the
 * updated stamp away, and answers the fields it writes.
 */
export function refuseFixed(
	ctx: CollectionContext,
	method: string,
	patch: Fields,
): Set<string> {
	const { written, removed } = touchedBy(patch);
	const fixed = [...keptByCollection(ctx), ctx.stamps.createdAt];
	for (const name of fixed) {
		if (name && written.has(name)) throw refused(ctx, method, name);
	}
	const { updatedAt } = ctx.stamps;
	if (updatedAt && removed.has(updatedAt)) {
		throw new TypeError(
			`${method}: "${updatedAt}" is kept by "${ctx.name}" itself and cannot ` +
				'be removed, renamed away or renamed onto. `raw` is the way to do it by hand.',
		);
	}
	return written;
}
