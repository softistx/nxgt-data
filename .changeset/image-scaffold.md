---
"@nxgt/image": minor
---

First version of `@nxgt/image`, for avatar and photo uploads on Bun's own `Bun.Image`, with no dependency at all. It exports `ImageError`, whose `code` is `TOO_LARGE`, `UNSUPPORTED_TYPE`, `UNDECODABLE` or `TOO_SMALL` and whose `reason` (`bytes`, `pixels`, `format`, `heic-unavailable`, `decode` or `dimensions`) tells a caller which limit or check refused the upload. The processing entry points follow in later releases.
