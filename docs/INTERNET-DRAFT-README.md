<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->
<!-- How to build and submit draft-trooth-signed-web-content. Follows the IETF Datatracker submission process and the kramdown-rfc workflow the HTTP and Web Bot Auth working groups use. -->

# Building and submitting the Internet-Draft

The draft is `docs/draft-trooth-signed-web-content-00.md`, written in kramdown-rfc markdown.

## Hold until the provisional patent is filed

The draft is filed with the IETF only after the provisional patent application is filed (decision D13 in the implementation spec). Publishing an Internet-Draft is a public disclosure; filing the provisional first keeps the priority date. Do not upload, post to a mailing list, or push the draft to a public repository before counsel confirms the filing. Building it locally is fine.

## Build

kramdown-rfc is a Ruby gem; xml2rfc is a Python tool. Both are needed to go from markdown to the text and HTML forms the Datatracker accepts.

```
gem install kramdown-rfc
pip install xml2rfc

kdrfc docs/draft-trooth-signed-web-content-00.md
```

`kdrfc` writes `draft-trooth-signed-web-content-00.xml` (RFC XML v3) and runs `xml2rfc` to produce `.txt` and `.html` beside it. The first run fetches the reference entries for every RFC and draft named in the front matter and caches them under `~/.cache/xml2rfc`; it needs network once.

To check only the XML: `kramdown-rfc docs/draft-trooth-signed-web-content-00.md > /tmp/draft.xml && xml2rfc --v3 /tmp/draft.xml --text`.

Common build problems:

- A reference name in the front matter that is not in the IETF reference index (a misspelled RFC number or draft name) fails the fetch. Every reference in the front matter today is a published RFC or an active draft; the one non-IETF reference (C2SP checkpoint) is given inline with a target URL.
- `{::boilerplate bcp14-tagged}` needs RFC 2119 and RFC 8174 in the normative list. They are.
- Lines inside `~~~` blocks longer than 69 characters trigger an xml2rfc warning in text output. The examples wrap long values and say so.

## Before submitting

1. Run `idnits` on the text output: `idnits draft-trooth-signed-web-content-00.txt`. Fix every error; warnings about example domains are acceptable because the examples use acme.com and fixture keys.
2. Re-read the implementation notes. The draft uses generic names (`Content-Version`, `Content-Hash`, tag `signed-web-content`, `/.well-known/signed-web-content-keys.json`, `_swc`) and names Trooth's deployed names as implementation notes. Keep it that way; a draft that reads as one vendor's header names does not get adopted.
3. Check that the test vector values quoted in the draft match `verifier/test-vectors/v1/response.json` and `log.json` after any regeneration.
4. Confirm the author block: Trooth LLC, dandre@trooth.co.

## Submit

1. Create a Datatracker account at https://datatracker.ietf.org/accounts/create/ with the author email.
2. Go to https://datatracker.ietf.org/submit/, upload the `.xml` (the Datatracker generates text and HTML itself), and confirm from the email it sends.
3. The draft appears at https://datatracker.ietf.org/doc/draft-trooth-signed-web-content/ within a few minutes as an individual submission.
4. Post a short note to the Web Bot Auth working group list (web-bot-auth@ietf.org) and the HTTP working group list (ietf-http-wg@w3.org) with the link, one paragraph on the problem (requests are signed, answers are not), and the open verifier. Ask for review, not adoption; adoption is the chairs' call after discussion.
5. Record the submission date, the draft URL and the list threads in the project's progress log.

## Revising

Each revision increments the number in both `docname` in the front matter and the file name (`-01`, `-02`). Keep a one-paragraph change list at the top of the `--- note_Note_to_Readers` block so reviewers see what moved. A draft expires 185 days after submission unless a new revision is uploaded; put a reminder in the calendar at 170 days.
