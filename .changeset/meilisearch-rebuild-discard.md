---
'@nxgt/meilisearch': patch
---

`rebuild` no longer says the next index "could not be deleted" when there was none to delete. When creating `movies_next` was the refused step — a key without `indexes.create` — the deletion that follows fails `index_not_found`, which now counts as gone: the `REBUILD_FAILED` message reads `"movies_next" was deleted, and "movies" is as it was`, as it does for every other stop while creating. A spec pins it with such a key.

`tenantToken`'s refusal of a `searchRules` that is not a plain object now reads `tenantToken for "movies": searchRules must be a plain object`. It used to add `, not one that inherits its rules`, which was wrong for a class instance, refused by the same check. An object with a `null` prototype is plain, and accepted, as before; a spec now pins both.

Not in 0.4.0's notes, and unchanged: `rebuild(fill, { nextUid })` with `nextUid` equal to the index's own uid throws a bare `TypeError` before anything is sent — `rebuild on "movies": nextUid must differ from the index's own uid`.

The docs follow: the README and `errors.md` list what is not wrapped in a `REBUILD_FAILED` (the lookup of a leftover `_next` included) and `tenantToken`'s `TypeError`s; the troubleshooting page has an entry for a rebuild stopped while `swapping`; and the roadmap says a failure deletes the next index or says it could not, and deletes nothing when the swap's outcome is unknown.
