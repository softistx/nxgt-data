---
'@nxgt/mongo': patch
---

`paginateByCursor` no longer throws when the `orderBy` field is null or missing on the last document of a page. Null and missing values are ordered as MongoDB sorts them (first ascending, last descending), the cursor carries `null`, and the next page resumes after it without skipping or repeating a document.
