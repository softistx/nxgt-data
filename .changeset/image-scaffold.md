---
"@nxgt/image": minor
---

First version of `@nxgt/image`, for avatar and photo uploads on Bun's own `Bun.Image`, with no required dependency (`@nxgt/s3` is an optional peer, for `@nxgt/image/s3`). It exports `ImageError`, whose `code` is `TOO_LARGE`, `UNSUPPORTED_TYPE`, `UNDECODABLE` or `TOO_SMALL` and whose `reason` (`bytes`, `pixels`, `format`, `heic-unavailable`, `decode` or `dimensions`) tells a caller which limit or check refused the upload.
