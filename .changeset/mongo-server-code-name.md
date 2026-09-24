---
"@nxgt/mongo": patch
---

Say where `serverCodeName` comes from. A write error — one document refused inside the server's insert, update or delete command — carries no `codeName`, so `updateMany` gives `serverCode: 121` with no name where `update` (a `findAndModify`) gives `DocumentValidationFailure`. Match on `serverCode`.
