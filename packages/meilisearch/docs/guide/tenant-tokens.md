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
| `indexes` | bound indexes, at least one | required | the indexes the token may search; every other one is refused |
| `searchRules` | `{ [uid]?: { filter? } \| null }` | `{}`: no filter on any index | keyed by the uids of `indexes`, and nothing else |
| `expiresAt` | `Date \| number` | none: the token lives as long as its key | a `Date`, or whole **seconds** since the epoch |
| `algorithm` | `'HS256' \| 'HS384' \| 'HS512'` | `'HS256'` | the SDK's |
| `force` | `boolean` | `false` | the SDK's: skip its check that it runs on a server |

`searchRules` is typed by `indexes`: its keys are the uids their definitions
declare, so a rule for an index the token was not given, or a misspelt uid,
does not compile. `filter` is the SDK's `Filter`, a string or an array, as in
a search.

An index in `indexes` with no rule, or with `null`, is searched with no
filter. An index **not** in `indexes` cannot be searched at all.

The types check the keys against the uids the definitions **declare**; the
function checks them again against the uids the indexes **have**, and a key
that is none of them throws a `TypeError` rather than leave its index
unfiltered:

```
tenantToken for "movies_next": searchRules names "movies", which is not the uid of any of its indexes
```

That is the one case the types cannot see: `rebuild` hands `fill` an index
whose uid is `movies_next`, typed `string` — any key compiles for it.

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
| a `Date` or a number of seconds already past | `is in the past` |
| a number past 10¹¹ | `is a number of milliseconds; it takes seconds, or a Date` |
| a number with a fraction | `is not a whole number of seconds` |
| an invalid `Date` | `is an invalid Date` |
| `NaN`, `Infinity` | `is neither a Date nor a finite number` |

The message never holds the key, the time, or anything else it was given.
`indexUid` is the token's uids joined by `,` — `'movies,people'`.

```ts
import { SearchIndexError } from '@nxgt/meilisearch';

try {
	return await tenantToken({ apiKey, apiKeyUid, indexes: [movieIndex], expiresAt });
} catch (error) {
	if (error instanceof SearchIndexError && error.code === 'INVALID_EXPIRES_AT') {
		return c.json({ error: 'expiresAt' }, 400);
	}
	throw error;
}
```

## Traps

- **No `expiresAt` and no rule make a permanent, unfiltered credential.**
  Without `expiresAt` a token lives as long as its key; an index given no
  rule is searched with no filter. A token like that, handed to a browser,
  reads every document of the index for as long as the key exists. Give
  every browser token both.
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
