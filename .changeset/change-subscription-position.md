---
"@nxgt/mongo": minor
---

`onChange`'s subscription gains `position`: where the stream is, changes or not. `resumeToken` is the last change handled and stands still while the collection is quiet; `position` is that token, or, after a read that brought nothing, the point the server gave, and every change up to it has been handled. A worker that records `position` instead is not sent back to the start of a long silence by a history the server has since dropped.
