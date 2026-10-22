// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Trooth, LLC
//
// Reads a revocation list exactly as the Semanto Worker served it (GET
// /public/semanto/{trooth_id}/revocations), when the Worker's own test
// suite hands one over in SEMANTO_SERVED_REVOCATIONS: the list must check out
// against Trooth's keys and the withdrawn version must read "withdrawn".
// Without the variable the test is skipped, so the Go tests stand alone.
package semanto

import (
	"os"
	"testing"
)

func TestServedRevocationList(t *testing.T) {
	path := os.Getenv("SEMANTO_SERVED_REVOCATIONS")
	if path == "" {
		t.Skip("SEMANTO_SERVED_REVOCATIONS is not set; the Worker's test suite sets it")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var v map[string]any
	if err := DecodeJSON(b, &v); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	keys := CollectKeys(getMap(v, "keys"))
	now := at(t, getStr(v, "now"))
	l := VerifyRevocationList(getStr(getMap(v, "served"), "jws"), keys, now)
	if !l.OK {
		t.Fatalf("the served revocation list did not check out: %s", l.Reason)
	}
	payload, _ := l.Payload.(map[string]any)
	if s := StateOf(getMap(v, "file"), now, payload, 0); s != "withdrawn" {
		t.Fatalf("the withdrawn version reads %q, not withdrawn", s)
	}
}
