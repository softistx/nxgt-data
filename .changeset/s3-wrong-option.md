---
'@nxgt/s3': minor
---

A wrong `acl`, `storageClass` or `expiresIn` is refused here, before anything
is sent or signed.

```ts
await reports.put('q1', csv, { acl: 'public' as never });
// S3Error: acl must be one of private, public-read, …; got "public"
```

`S3ErrorCode` gains `WRONG_OPTION`, so every refusal of a write or a signed
URL is one class with a code to switch on. Bun checks these values as well,
and refuses with a plain `TypeError` — measured on bun 1.4.2 — so one `put`
had two classes of refusal: an `S3Error` with a code for the content type and
the size, a `TypeError` with only a sentence for the rest.

**`presignGet` and `presignPut` are held to the same guard.** They forward
`acl` too, and forwarded it unchecked, so one mistake was two classes
depending on which call it reached.

**`expiresIn` is bounded at both ends.** Bun refuses `0` and below itself;
measured, it *signs* an `expiresIn` of `1e12` happily, and S3 caps a
presigned URL at seven days — so this package used to hand back a URL the
service would reject at use time, which is the one thing it exists not to do.
It is now `WRONG_OPTION` above 604 800 seconds, at or below zero, and for
anything that is not a finite number.

The accepted values live with the other guards and are proved exhaustive at
compile time, the way the forwarded option names already were: a value Bun
adds or drops fails the build here rather than silently widening or narrowing
what this package accepts. `test/types/s3.ts` carries the `@ts-expect-error`
cases for the two unions.
