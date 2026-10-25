# Roadmap

Where `@nxgt/image` is going. A direction, not a commitment: the version an
item shipped in is the only number on this page.

## Now

_Nothing queued._

## Next

_Nothing queued._

## Later

- **HEIC on Linux** — an iPhone photo decodes on a Linux server too, once Bun
  can decode HEIC there. Until then such an upload is refused with
  `UNSUPPORTED_TYPE` and the reason `heic-unavailable`.
- **A crop done by Bun itself** — the same square for less memory, if Bun
  adds a crop of its own.
- **Cancel a queued call (`AbortSignal`)** — a call that waits for a free
  decoding slot gives up when its caller does, instead of holding its bytes.
- **Colour conversion to sRGB** — a wide-gamut photo keeps its colours instead
  of losing its profile, if Bun supports the conversion.
- **A low-quality placeholder per image** — a tiny blurred preview to show
  while the real one loads, from `Bun.Image.placeholder()`.

## Not planned

- **A third-party image library (sharp)** — the package runs on Bun's own
  `Bun.Image` and has no required dependency (`@nxgt/s3` is an optional peer).
  That is the point of it, and a feature Bun lacks waits for Bun, as the
  entries under Later do.
- **Public URLs** — a stored image is never public: no `acl` is ever passed,
  and a link comes from `presignGet`, which expires.

## Shipped

- **Processing an upload into square WebP variants** —
  `defineImageSet().process` takes bytes, a buffer, a `Blob` or a stream and
  returns one square `image/webp` per size. JPEG, PNG, WebP and HEIC are
  recognised by their first bytes, not the name or the declared type; a size
  cap and a pixel cap refuse an oversized upload before it is decoded; the
  crop is centred unless the caller gives one; every piece of metadata (EXIF
  with its GPS, and the ICC profile) is stripped; `concurrency` bounds how
  many uploads decode at once, and is not a hard memory ceiling. Every refusal is an `ImageError`
  with a `code` to switch on — 0.1.0.
- **Storing the variants in a bucket** — `@nxgt/image/s3` `bindImageStore`
  gives `replace`, `remove`, `presignGet` and `bytes` over a `@nxgt/s3`
  bucket. `replace` returns a `version` that changes with the content, a
  refused upload writes nothing, and objects are never public — 0.1.0.

Everything released is in [`CHANGELOG.md`](https://github.com/softistx/nxgt-data/blob/develop/packages/image/CHANGELOG.md) — it is not in
the published package, only in the repository.
