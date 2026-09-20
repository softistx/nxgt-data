---
'@nxgt/meilisearch': minor
---

`diffSettings` takes a definition's own settings.

```ts
const update = diffSettings(movies.settings, await index.getSettings());
```

That line did not compile. `defineIndex` infers a definition's lists as
`readonly` — which is what makes `SortableOf` and the typed `sort` work — and
the SDK's `Settings` has mutable arrays, so the obvious call was a type error
and every call site needed a cast. This package's own `syncIndex` had one; it
is gone.

The first parameter is now `WantedSettings`, exported: the settings as
something *wants* them, with every list `readonly` and every value allowed to
be `undefined`. A plain, mutable `Settings` from anywhere else still goes in,
and what comes back is still a `Settings` the SDK will take.
