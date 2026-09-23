---
'@nxgt/meilisearch': minor
---

`defineIndex` now refuses, at definition, a uid Meilisearch would refuse: empty, over 400 characters, or holding anything but ASCII letters, digits, `-` and `_` — a `*`, a space, a dot, a slash, a unicode lookalike. It throws a bare `TypeError`, `defineIndex: the uid must be 1 to 400 characters, each an ASCII letter, a digit, - or _`, which names the shape and never the uid. Before, such a uid reached the server, which refused it with `invalid_index_uid` on the first request, or `tenantToken`, which has refused it since 0.5.0 because a token's rule keys are index patterns and a `*` would widen the token.

A literal `'*'`, `''`, or one holding a space, a dot or a slash no longer compiles. A uid typed `string`, a generic uid, a union of literals with one valid member, or one holding anything else, still compiles and is checked at run time only.

`bindIndex` checks the uid of a definition that did not come from `defineIndex` with the same rule. `rebuild` throws a `TypeError` before sending anything when its next uid would be refused, where it failed before on its first request with the SDK's error: the default `<uid>_next` of a uid over 395 characters (`…; a uid over 395 characters needs a shorter nextUid` — pass a shorter `nextUid`), or a `nextUid` given that is not a uid (`rebuild on "<uid>": nextUid must be 1 to 400 characters, each an ASCII letter, a digit, - or _`). Neither message quotes the `nextUid`.

A consumer whose uid is now refused could not have created that index on Meilisearch v1.53.2: rename it to letters, digits, `-` and `_`.
