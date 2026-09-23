# Tenant tokens

A tenant token lets a browser, or any client you do not trust, search
Meilisearch directly — only the indexes you name, and in each only the
documents a filter matches. Your server signs it with a search key; the
client never sees the key.

```ts
import { Meilisearch } from 'meilisearch';
import { bindIndex, tenantToken } from '@nxgt/meilisearch';
import { movies } from './indexes';

const movieIndex = bindIndex(client, movies);

// on the server, per user: `searchKey` is a key with the `search` action on 'movies'
const token = await tenantToken({
	apiKey: searchKey.key,
	apiKeyUid: searchKey.uid,
	indexes: [movieIndex],
	searchRules: { movies: { filter: `genres = ${JSON.stringify(user.genre)}` } },
	expiresAt: new Date(Date.now() + 60 * 60 * 1000),
});

// in the browser: a client made from the token, and nothing else
const scoped = new Meilisearch({ host, apiKey: token });
await scoped.index('movies').search('alien'); // only that genre's movies
```

`tenantToken` wraps the SDK's `generateTenantToken`, from
`meilisearch/token`. It signs locally and sends nothing: Meilisearch checks
the token when a client made from it searches.

## The options

| Option | Type | Default | |
| --- | --- | --- | --- |
| `apiKey` | `string` | required | the key that signs. It needs the `search` action on every index the token names |
| `apiKeyUid` | `string` | required | that key's `uid`, a UUID v4 |
| `indexes` | bound indexes, at least one | required | the indexes the token may search; every other one is refused. Each uid must be letters, digits, `-` and `_`: a `*` would be read as a pattern |
| `searchRules` | `{ [uid]: { filter } \| null }` | required, one rule **per index** | keyed by the uids of `indexes`, and nothing else; `filter` is required in a rule, and must filter something; `null`, and only `null`, searches that index with no filter |
| `expiresAt` | `Date \| number` | required | a `Date`, or whole **seconds** since the epoch |
| `algorithm` | `'HS256' \| 'HS384' \| 'HS512'` | `'HS256'` | the SDK's |
| `force` | `boolean` | `false` | the SDK's: skip its check that it runs on a server |

`searchRules` is typed by `indexes`: its keys are the uids their definitions
declare, so a rule for an index the token was not given, or a misspelt uid,
does not compile. `filter` is the SDK's `Filter`, a string or an array, as in
a search.

Every index in `indexes` needs a rule. `{ filter }` is added to every
search on it; `null` searches it with **no** filter, and has to be written
out. An index **not** in `indexes` cannot be searched at all.

```ts
await tenantToken({
	apiKey: searchKey.key,
	apiKeyUid: searchKey.uid,
	indexes: [movieIndex, genreIndex],
	searchRules: { movies: { filter: `tenant = ${JSON.stringify(user.tenant)}` }, genres: null },
	expiresAt: new Date(Date.now() + 60 * 60 * 1000),
});
```

A rule left out does not compile. The function checks again at run time,
since a uid can be dynamic, and a missing rule — or one that is
`undefined` — throws a `TypeError` before anything is signed:

```
tenantToken for "movies", "people": searchRules has no rule for "people"; give each index { filter: … }, or null to search it with no filter
```

"No filter" is spelled only `null`. A rule object must carry `filter` — the
types require it, where the SDK's `TokenIndexRules` leaves it optional — so
`{}`, `{ filter: undefined }` and `{ filter: null }` do not compile. A filter
that filters nothing does compile, since the SDK's `Filter` is any string or
array, and is refused at run time with the rest: a blank string (`''`,
`'  '`, `'\u0085'` — blank as the server reads it: Rust's `White_Space`, which is JavaScript's `\s` plus U+0085 (NEL), measured on v1.53.2; `trim()`
keeps U+0085, which is why it is not used. U+FEFF is in `\s`, so a filter
of only U+FEFF is refused too, though the server answers it with a 400
rather than reading it as no filter), an empty array, or an array of those
(`['', []]`):

```
tenantToken for "movies", "people": searchRules has an empty rule for "people"; give it { filter: … }, or null to search it with no filter
```

An empty rule is a bare `TypeError`, not a coded error: a tenant filter is
built by your server from the caller's identity, not taken from a request,
so an empty one is wiring to fix, not input to answer with a 400.

Each rule is read **once**, into a plain copy; the checks run on that copy,
and that copy is what is signed. The SDK signs `JSON.stringify` of the rules
it is given, so a check that read the caller's object could pass on
something that serialises to no filter — measured on v1.53.2, a getter, a
`toJSON` returning `null`, an inherited or non-enumerable `filter`, and a
`NaN` filter each signed an unfiltered token. A rule is therefore `null`, or
a plain object — prototype `Object.prototype` or `null` — whose one key is
an own, enumerable data property `filter` holding a string, or an array of
strings and arrays of strings. Anything else is a `TypeError` naming the
index and the shape, never the value:

| Rule | Message, after `tenantToken for "movies": searchRules has a rule for "movies" ` |
| --- | --- |
| a class instance, or one that inherits its `filter` | `that is not a plain object` |
| an array, `['']` | `that is an array` |
| a string or a number | `that is a string`, `that is a number` |
| a getter on `searchRules` | `that is a getter` |
| a non-enumerable rule on `searchRules` | `that is not enumerable` |
| a `toJSON` on the rule, or on its filter | `that has a toJSON`, `whose filter has a toJSON` |
| a key beside `filter` | `that has a key other than filter` |
| a `filter` that is a getter, or not enumerable | `whose filter is a getter`, `whose filter is not enumerable` |
| a `filter` that is `NaN`, a function, a symbol | `whose filter is a number`, `… a function`, `… a symbol` |
| a `filter` that is an object or a boolean | `whose filter is an object`, `whose filter is a boolean` |
| an array holding something else, or nested too deep | `whose filter holds a number`, `whose filter holds an array` |
| an array holding `undefined` or `null` | `whose filter holds undefined`, `whose filter holds null` |

Each ends `; give it { filter: … }, or null to search it with no filter`.
The SDK's `TokenIndexRules` has no key but `filter` in meilisearch-js 0.62.0,
so any other key is refused rather than copied.

The types check the keys against the uids the definitions **declare**; the
function checks them again against the uids the indexes **have**, and a key
that is none of them throws a `TypeError` rather than leave its index
unfiltered:

```
tenantToken for "movies_next": searchRules names "movies", which is not the uid of any of its indexes
```

A `searchRules` that is not a plain object — one that inherits its rules,
`Object.create({ movies: … })`, or a class instance — is refused the same
way, since an inherited rule is not read:
`tenantToken for "movies": searchRules must be a plain object`. An object
with a `null` prototype is plain, and accepted.

What the types cannot see is refused at run time only: a missing or
unmatched rule for an index whose uid is not one literal, an empty filter
(`''`, `[]`, which the SDK's `Filter` type allows), and the shapes in the
table above that TypeScript cannot tell apart — a class whose `filter` is a
getter fits `{ filter: string }`. `rebuild` hands `fill` an index whose uid
is `movies_next`, typed `string` — any key compiles for it, and none is
required. Key its rule by its runtime uid:

```ts
await movieIndex.rebuild(async (next) => {
	await next.add(await loadMovies());
	const token = await tenantToken({
		apiKey, apiKeyUid, indexes: [next],
		searchRules: { [next.uid]: { filter: 'genres = scifi' } },
		expiresAt: new Date(Date.now() + 60_000),
	});
});
```

Beside an index with a literal uid, that one's rule is still required by
the types. An index typed as a union of uids — `cond ? movieIndex :
peopleIndex` — is treated the same way: the types cannot require both keys
for one index, so it is keyed by its `uid`, and checked at run time:

```ts
const index = user.isStaff ? movieIndex : peopleIndex;
await tenantToken({ apiKey, apiKeyUid, indexes: [index], searchRules: { [index.uid]: { filter } }, expiresAt });
```

## Index uids

Meilisearch reads the keys of a token's rules as index **patterns**, not
names: measured on v1.53.2, an index bound under the uid `*` with a `null`
rule signed a token that searched every other index. An index is
therefore refused unless its uid is a Meilisearch index uid:

| Index uid | Refused as |
| --- | --- |
| `*`, `movies*`, `docs_${tenant}` where the tenant holds a `*` | `tenantToken: an index uid is not a valid Meilisearch uid (letters, digits, - and _ only), and a * in it would widen the token to other indexes` |
| `''`, or one with a space or any other character | the same |

The message names no uid, since one built from a request could hold
anything. A rule keyed by a pattern beside valid indexes is refused as an
unmatched key. `defineIndex` does not check the uid today; build a uid from
a request only after checking it against `/^[A-Za-z0-9_-]{1,400}$/`.

## What was measured

Against Meilisearch v1.53.2, with a key holding `search` on `movies` only.
Each is a spec in `src/token/tenant-token.spec.ts`:

- a search with the token returns only the documents the filter matches.
  The rule is **added** to the search's own `filter`, not replaced by it:
  `filter: 'year > 1990'` under a rule `genres = scifi` returns the scifi
  movies after 1990. It holds in a multi-search too;
- an index the token was not given:
  ``The provided tenant token cannot acces the index `people`, allowed indexes are ["movies"].``
- an index the token names but the key does not cover:
  ``The API key used to generate this tenant token cannot acces the index `people`.``
- a token past its `exp`, signed with the SDK directly since `tenantToken`
  refuses to: ``Tenant token expired. Was valid up to `1790139850` and we're now `1790139910`.``,
  a `MeilisearchApiError` with `cause.code` `invalid_api_key` and status
  403;
- a deleted key takes its tokens with it: ``The provided API key is invalid.``

And against the same server, by hand rather than as specs — the reasons
`tenantToken` refuses some times before signing:

- an `exp` with a fraction of a second makes every search with the token
  fail — *Could not decode tenant token, JSON error: invalid type: floating
  point …, expected i64* — so a number that is not whole is refused;
- an `exp` in **milliseconds** is accepted, and the token lasts some 56 000
  years; a number past 10¹¹ — the year 5138 in seconds — is refused as one;
- a key that expires takes its tokens with it too, whatever their own `exp`.

## When `expiresAt` is refused

`tenantToken` throws a `SearchIndexError` with `code: 'INVALID_EXPIRES_AT'`,
before anything is signed, when `expiresAt` is:

| `expiresAt` | Message, after `tenantToken for "movies": expiresAt ` |
| --- | --- |
| missing: `undefined` or `null` | `is missing; it takes a Date, or whole seconds since the epoch` |
| a `Date` or a number of seconds already past | `is in the past` |
| a number past 10¹¹ | `is a number of milliseconds; it takes seconds, or a Date` |
| a number with a fraction | `is not a whole number of seconds` |
| an invalid `Date` | `is an invalid Date` |
| a `Date` past the year 5138 — `new Date(ms * 1000)` | `is a Date past the year 5138; was it built from milliseconds times 1000?` |
| `NaN`, `Infinity`, or an object that only looks like a `Date` | `is neither a Date nor a finite number` |

A `Date` is read **once**, with the intrinsic `Date.prototype.getTime`, and
the whole seconds it gives are what is checked and signed — never the
object itself, which the SDK would read again. Measured on v1.53.2 before
this: a `Date` subclass whose `getTime` changed between calls, or an object
given `Date.prototype` with a `getTime` of its own, signed an `exp` of
`null` or of 10¹⁷, which the server takes as no expiry. A real `Date` whose
own `getTime` lies signs its real time; an object that is not a `Date` has
no time, and is refused.

A missing `expiresAt` takes the same code as a wrong one, not a
`TypeError`: it is the same option, it can come from a request body just as
well, and a handler that answers `INVALID_EXPIRES_AT` with a 400 should not
need a second branch for it.

The message never holds the key, the time, or anything else it was given.
`indexUid` is the token's uids joined by `,` — `'movies,people'`.

```ts
import { SearchIndexError } from '@nxgt/meilisearch';

try {
	return await tenantToken({ apiKey, apiKeyUid, indexes: [movieIndex], searchRules: { movies: { filter } }, expiresAt });
} catch (error) {
	if (error instanceof SearchIndexError && error.code === 'INVALID_EXPIRES_AT') {
		return c.json({ error: 'expiresAt' }, 400);
	}
	throw error;
}
```

## Traps

- **Why `expiresAt` and a rule per index are required.** Before 0.5.0 both
  were optional: without `expiresAt` a token lived as long as its key, and
  an index given no rule was searched with no filter. A token that forgot
  both — one line left out, or a `filter` that came back `undefined` — was a
  permanent, unfiltered credential, handed to a browser, reading every
  document of the index for as long as the key existed, and nothing said
  so. Now the omission is refused, in the types and at run time, and an
  unfiltered index takes an explicit `null` a reviewer can see.
- **`null` still reads everything.** Write it only for an index every
  holder of the token may read in full, and keep `expiresAt` short.
- **An empty rule is not a quieter `null`.** `{}` or `{ filter: '' }` — a
  filter built from a value that came back empty — would sign the same
  unfiltered token, without the `null` a reviewer can see. Both are
  refused; decide between a real filter and `null`.
- **Sign with a search key, never the master key.** The signing key lives
  on your server as long as tokens are issued: make it one that can only
  search, on only the indexes the tokens name.
- **The filter is a string you build.** A value from a request goes in
  through `JSON.stringify`, as a quoted string, or it can change the filter:
  `genres = ${JSON.stringify(genre)}`.
- **The rule's attributes must be filterable on the live index.** Otherwise
  every search with the token fails with ``Attribute `country` is not
  filterable.`` — `sync` first.
- **A token lives no longer than its key**, whatever `expiresAt` says: deleting
  or rotating the key revokes every token it signed, and a key's own
  `expiresAt` ends them too.
- **`generateTenantToken` refuses to run in a browser**: it checks that it
  is on a server (Node, Bun, Deno, Cloudflare Workers) and throws
  otherwise — read from the SDK's source, not measured, since the specs run
  on Bun. Sign on the server and send the token; `force: true` skips the
  check, for a server the SDK does not recognise.
