---
"@nxgt/mongo": patch
---

Say that without post-images an update read after its document was hard deleted arrives with `document: undefined`: the document is looked up when the change is read, and a subscription only a little behind is enough.
