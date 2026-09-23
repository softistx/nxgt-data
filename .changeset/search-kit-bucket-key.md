---
'@nxgt/mongo-search-kit': patch
---

`createSearchKit` refuses a key the kit wires a GridFS bucket under with its own message, `this kit wires no collection called "uploads"`. `@nxgt/mongo-kit` 0.4.0 puts buckets on the scope beside the collections, and a bucket carries a `definition` too, so the old check let it through to fail later on something unrelated. It now reads the definition's shape: a collection's has a schema, a bucket's does not.
