---
"@nxgt/mongo": patch
---

Say where `serverCodeName` comes from: MongoDB names the code only when it answers a `find` or a `findAndModify`, so `update` gives `DocumentValidationFailure` and `updateMany` gives the same `serverCode: 121` with no name. Match on `serverCode`.
