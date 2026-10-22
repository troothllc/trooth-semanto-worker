<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright (c) 2026 Trooth, LLC -->

# semanto-verify (JavaScript)

One dependency-free ES module, `verify.mjs`, for Node 20+ and browsers (WebCrypto only), plus `cli.mjs`.

```
node verifier/js/cli.mjs file verifier/test-vectors/v1/semanto.json --pages verifier/test-vectors/v1/pages
node verifier/js/cli.mjs page https://acme.com/security
node verifier/js/cli.mjs response https://acme.com/security
node verifier/js/cli.mjs log --from 1200 --to 1340
```

`file` needs no network when `--keys` is given or a `keys.json` sits beside the file (the vectors ship one). `page` fetches the URL with `Accept: text/markdown`, the JWK Sets from the domain and from Trooth, the `_trooth` DNS TXT record, and the proof the response links to with `rel="proof"`, then prints every check in plain words. Exit code 0 means every check passed; 1 means at least one failed; 2 means the command was wrong.

In a browser:

```html
<script type="module">
  import { verifyResponse } from "https://trooth.co/verifier/verify.mjs";
  const r = await fetch("/security", { headers: { Accept: "text/markdown" } });
  const body = new Uint8Array(await r.arrayBuffer());
  const keys = await (await fetch("/.well-known/trooth-keys.json")).json();
  const result = await verifyResponse(r.status, Object.fromEntries(r.headers), body, keys);
  console.log(result.ok, result.checks);
</script>
```

Functions: `verifySemanto(file, pageBytesByUrl, keys, { now, revocations })`, `verifyPageProof(proof, pageBytes, keys, { now })`, `verifyResponse(status, headers, body, keys, { now })`, `verifyWebBotAuthRequest`, `verifyTreeHead`, `verifyInclusionInLog`, `verifyConsistency`, `verifyCheckpoint`, `verifyOffer`, `verifyRevocationList`, `stateOf(version, now, revocations)`, plus `canonicalize` (RFC 8785), `sha256`, the RFC 6962 primitives, `verifyJws` and `verifyMessage` (RFC 9421). Every result is `{ ok, reason, checks: [{ name, ok, detail }] }` with the reason codes listed in `verifier/test-vectors/v1/README.md`. Type declarations are in `verify.d.mts`.
