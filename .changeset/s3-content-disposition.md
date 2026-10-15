---
"@nxgt/s3": minor
---

A signed download link can now save the object under a name you choose:
`store.presignGet(params, { expiresIn: 300, contentDisposition: "attachment; filename*=UTF-8''report.pdf" })`
signs `response-content-disposition`, so the service serves that link with
the header, whatever the object was stored with. `presignPost` takes a
`contentDisposition` too, pinned in the policy as a `Content-Disposition`
field. `presignPut` takes none (its type refuses it), and `PresignGetOptions`
is exported.

The value must be a non-empty string of printable ASCII, with no line break
or control character; anything else is an `S3Error` with `code:
'WRONG_OPTION'` and nothing is signed. `put`'s `contentDisposition` is held
to the same check now: a value that is empty, not a string, or holds a
control or non-ASCII character is refused before the write, where it used to
reach the service as it came. A non-ASCII filename is spelled
`filename*=UTF-8''...`, percent-encoded.
