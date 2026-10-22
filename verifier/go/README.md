# trooth-semanto-verify (Go)

Check a Semanto by Trooth file, a page proof, a signed response or the public log, offline, with the Go standard library only (`crypto/ed25519`, `crypto/sha256`, `encoding/json`, `encoding/base64`). Go 1.22 or newer.

```
go install github.com/troothllc/trooth-semanto-verify/cmd/semanto-verify@latest
```

or from this folder: `go run ./cmd/semanto-verify file ../test-vectors/v1/semanto.json`

## Commands

```
semanto-verify file <semanto.json> [-pages <dir>] [-keys <keys.json>] [-now <iso>] [-revocations <file>]
semanto-verify page <url> [-trooth <base>] [-now <iso>]
semanto-verify response <url> [-keys <keys.json>]
semanto-verify log -from <n> -to <m> [-log <url>] [-keys <keys.json>]
```

`file` needs no network when `-keys` is given or a `keys.json` sits beside the file. Pages are read from `<dir>/<page id>.md`. Exit code 0 means every check passed; 1 means at least one failed.

## Library

```go
import "github.com/troothllc/trooth-semanto-verify/semanto"

var file map[string]any
semanto.DecodeJSON(fileBytes, &file)           // keeps numbers exact
keys := semanto.CollectKeys(jwksAny)           // a JWKS, a list of JWKS, or a map of them
r := semanto.VerifySemanto(file, map[string][]byte{"https://acme.com/security": md}, keys, time.Now(), nil)
for _, c := range r.Checks { fmt.Println(c.OK, c.Name, c.Detail) }
```

Functions and reason codes are the same as the JavaScript and Python kits: `VerifySemanto`, `VerifyPageProof`, `VerifyResponse`, `VerifyWebBotAuthRequest`, `VerifyTreeHead`, `VerifyInclusionInLog`, `VerifyConsistency`, `VerifyCheckpoint`, `VerifyOffer`, `VerifyRevocationList`, `StateOf`, plus `Canonicalize` (RFC 8785), the RFC 6962 primitives and `VerifyJWS`.

Decode JSON with `semanto.DecodeJSON` (it sets `UseNumber`), so a number reaches `Canonicalize` as its source text. A non-integer number is an error, because Semanto never signs one.

## Tests

`go test ./semanto/` runs every shared vector in `verifier/test-vectors/v1` (positive and negative), the RFC 6962 known roots, the RFC 8785 cases, the state rules and tampering in each layer.
