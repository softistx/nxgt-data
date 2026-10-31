---
'@nxgt/mongo': minor
---

Add a `cursorScope` collection option, taken by `getCollection` and by `options` / `optionsFor` of `defineMongo`: the `scope` of every `paginateByCursor` call that gives none, for a host that binds every list to one tenant. A call's own `scope` outranks it, and a collection without it is unchanged.
