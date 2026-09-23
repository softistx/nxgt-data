import type { TokenIndexRules, TokenSearchRules } from 'meilisearch';

/**
 * The run-time half of a token's rules: every rule is read **once**, into a
 * plain copy, every check runs on that copy, and that same copy is signed.
 * The SDK signs `JSON.stringify` of what it is given, so a check that reads
 * the caller's object and a signature that serialises it again can disagree
 * — a getter, a `toJSON`, an inherited or hidden `filter`, a `NaN` — and each
 * of those, measured on v1.53.2, signed an unfiltered token.
 *
 * A rule is `null`, or a plain object whose one key is an own, enumerable
 * data property `filter`: a string, or an array of strings and arrays of
 * strings. `filter` is the only key of the SDK's `TokenIndexRules` in
 * meilisearch-js 0.62.0; read its `token.d.ts` again before raising the peer.
 */

/** Why a rule is refused, as the end of a sentence: a shape, never a value. */
class Refusal {
	constructor(readonly problem: string) {}
}

const shapeOf = (value: unknown) => {
	if (value === null || value === undefined) return String(value);
	if (Array.isArray(value)) return 'an array';
	if (typeof value === 'object') return 'an object';
	return `a ${typeof value}`;
};

/** Whitespace as Meilisearch reads it: `\s`, U+0085 and U+FEFF. */
const BLANK = /[\s\u0085\uFEFF]/g;

/** Whether a copied filter filters nothing: blank, or only blanks. */
function isEmpty(filter: unknown): boolean {
	if (filter === undefined || filter === null) return true;
	// `trim` keeps U+0085 (NEL), which Meilisearch reads as blank: measured
	// on v1.53.2, a filter of only NEL signed an unfiltered token.
	if (typeof filter === 'string') return filter.replace(BLANK, '') === '';
	return Array.isArray(filter) && filter.every(isEmpty);
}

/** A copy of a filter, each entry read once; the SDK's `Filter` shape. */
function copyFilter(value: unknown, depth = 0): string | unknown[] {
	if (typeof value === 'string') return value;
	if (Array.isArray(value) && depth < 2) {
		if (Object.hasOwn(value, 'toJSON')) {
			throw new Refusal('whose filter has a toJSON');
		}
		const { length } = value;
		return Array.from({ length }, (_, i) => copyFilter(value[i], depth + 1));
	}
	const verb = depth === 0 ? 'is' : 'holds';
	throw new Refusal(`whose filter ${verb} ${shapeOf(value)}`);
}

/** A plain copy of one rule: `{}` for a filter left out, `undefined` or `null`. */
function copyRule(value: unknown): TokenIndexRules | null {
	if (value === null) return null;
	if (typeof value !== 'object') throw new Refusal(`that is ${shapeOf(value)}`);
	if (Array.isArray(value)) throw new Refusal('that is an array');
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Refusal('that is not a plain object');
	}
	const own = Object.getOwnPropertyDescriptors(value);
	if (Object.hasOwn(own, 'toJSON')) throw new Refusal('that has a toJSON');
	if (Reflect.ownKeys(own).some((key) => key !== 'filter')) {
		throw new Refusal('that has a key other than filter');
	}
	const filter = own.filter;
	if (filter === undefined) return {};
	if (!('value' in filter)) throw new Refusal('whose filter is a getter');
	if (!filter.enumerable) throw new Refusal('whose filter is not enumerable');
	if (filter.value === undefined || filter.value === null) return {};
	return { filter: copyFilter(filter.value) as TokenIndexRules['filter'] };
}

/** Uids as a message names them: `"movies", "people"`. */
export const quoted = (uids: readonly string[]) =>
	uids.map((uid) => `"${uid}"`).join(', ');

const give = 'or null to search it with no filter';

/**
 * The rules to sign, one plain copy per uid, or a `TypeError`: a rule that
 * would be dropped, missing, empty or read differently when signed would
 * leave its index unfiltered. `call` names the call, for the message.
 */
export function copyRules(
	given: unknown,
	uids: readonly string[],
	call: string,
): TokenSearchRules {
	// A rule inherited from a prototype is not an own key: it would be
	// dropped, and its index searched with no filter.
	const prototype =
		given === undefined || given === null
			? Object.prototype
			: Object.getPrototypeOf(given);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(`${call}: searchRules must be a plain object`);
	}
	const descriptors: Record<string, PropertyDescriptor> =
		given === undefined || given === null
			? {}
			: Object.getOwnPropertyDescriptors(given);
	// Own keys only: a uid such as `__proto__` must not reach the prototype.
	const own = (uid: string) =>
		Object.hasOwn(descriptors, uid) ? descriptors[uid] : undefined;
	// A rule under a uid no index has would otherwise be dropped: the types
	// cannot see a uid that differs at run time, such as a rebuild's next one.
	const unmatched = Object.keys(descriptors).filter(
		(uid) => !uids.includes(uid),
	);
	if (unmatched.length > 0) {
		throw new TypeError(
			`${call}: searchRules names ${quoted(unmatched)}, ` +
				'which is not the uid of any of its indexes',
		);
	}
	// No rule, or `undefined`, is refused: no filter takes an explicit `null`.
	const missing = uids.filter((uid) => {
		const rule = own(uid);
		return rule === undefined || ('value' in rule && rule.value === undefined);
	});
	if (missing.length > 0) {
		throw new TypeError(
			`${call}: searchRules has no rule for ${quoted(missing)}; ` +
				`give each index { filter: … }, ${give}`,
		);
	}
	const signed: Record<string, TokenIndexRules | null> = Object.create(null);
	for (const uid of uids) {
		const rule = own(uid) as PropertyDescriptor;
		try {
			if (!('value' in rule)) throw new Refusal('that is a getter');
			if (!rule.enumerable) throw new Refusal('that is not enumerable');
			signed[uid] = copyRule(rule.value);
		} catch (error) {
			if (!(error instanceof Refusal)) throw error;
			throw new TypeError(
				`${call}: searchRules has a rule for "${uid}" ${error.problem}; ` +
					`give it { filter: … }, ${give}`,
			);
		}
	}
	// A rule that filters nothing signs the same token as a missing one.
	const empty = uids.filter((uid) => {
		const rule = signed[uid];
		return rule !== null && rule !== undefined && isEmpty(rule.filter);
	});
	if (empty.length > 0) {
		throw new TypeError(
			`${call}: searchRules has an empty rule for ${quoted(empty)}; ` +
				`give it { filter: … }, ${give}`,
		);
	}
	return signed;
}
