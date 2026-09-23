/**
 * The one definition of a Meilisearch index uid, measured on v1.53.2: 1 to
 * 400 characters, each an ASCII letter, a digit, `-` or `_`. The server
 * refuses anything else with `invalid_index_uid` — a dot, a slash, a space,
 * `*`, a unicode lookalike, an empty string, 401 characters.
 *
 * It matters beyond the server's refusal: a tenant token's rule keys are read
 * as index **patterns**, so a `*` in a uid would widen a token to other
 * indexes. `defineIndex`, `bindIndex`, `rebuild` and `tenantToken` all check
 * with this one function.
 */
const INDEX_UID = /^[A-Za-z0-9_-]{1,400}$/;

/** What a valid uid is, for the messages: a shape, never the value. */
export const INDEX_UID_SHAPE =
	'1 to 400 characters, each an ASCII letter, a digit, - or _';

/** Whether `uid` is a string Meilisearch accepts as an index uid. */
export function isIndexUid(uid: unknown): uid is string {
	return typeof uid === 'string' && INDEX_UID.test(uid);
}
