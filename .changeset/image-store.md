---
"@nxgt/image": minor
---

New subpath `@nxgt/image/s3`: `bindImageStore(set, bucket)` stores the variants of an image set in a `@nxgt/s3` bucket whose key takes a `size` beside its other params (`@nxgt/s3` is an optional peer, and the root entry never imports it). `replace(params, input, { crop })` processes the upload, puts every size as `image/webp` and returns `{ version, variants }`, `version` being 16 hex characters of the SHA-256 over the variants' bytes. `remove(params)` deletes every size (a missing object is fine); `presignGet`, `bytes` and `keyFor` take a size, and a size outside the set is a `RangeError`. Objects are never public: no `acl` is ever passed. A refused upload writes nothing; a failed put deletes every size of those params and rethrows the first error, which suits keys with a fresh id per upload (`crypto.randomUUID()`), the recommended pattern: replace under the new id, store it, then remove the former id's set. An image set now also exposes its `sizes`.
