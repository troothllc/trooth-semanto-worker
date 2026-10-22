// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Trooth, LLC
//
// Flags after the file path are read (review finding 18): ParseInterspersed
// directly, and the semanto-verify command line run on the shared vectors
// with -pages after the path pointing at a tampered page, which must fail.
package semanto

import (
	"flag"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseInterspersedReadsFlagsAfterThePath(t *testing.T) {
	fs := flag.NewFlagSet("file", flag.ContinueOnError)
	pages := fs.String("pages", "", "")
	now := fs.String("now", "", "")
	pos, err := ParseInterspersed(fs, []string{"semanto.json", "-pages", "dir", "extra", "-now", "2026-10-22T12:00:10Z"})
	if err != nil {
		t.Fatal(err)
	}
	if *pages != "dir" || *now != "2026-10-22T12:00:10Z" || !reflect.DeepEqual(pos, []string{"semanto.json", "extra"}) {
		t.Fatalf("pages=%q now=%q pos=%v", *pages, *now, pos)
	}
	fs2 := flag.NewFlagSet("file", flag.ContinueOnError)
	_ = fs2.String("pages", "", "")
	pos2, _ := ParseInterspersed(fs2, []string{"a", "--", "-pages", "b"})
	if !reflect.DeepEqual(pos2, []string{"a", "-pages", "b"}) {
		t.Fatalf("after -- every word is positional: %v", pos2)
	}
}

func TestCLIReadsFlagsAfterTheFilePath(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go toolchain on PATH")
	}
	vec := filepath.Join(vectorDir, "semanto.json")
	keys := filepath.Join(vectorDir, "keys.json")
	tampered := filepath.Join("..", "..", "..", "test", "fixtures", "verifier", "tampered-pages")
	good := exec.Command("go", "run", "../cmd/semanto-verify", "file", vec, "-keys", keys, "-pages", filepath.Join(vectorDir, "pages"))
	out, err := good.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "3 of 3 pages were given") {
		t.Fatalf("good run: %v\n%s", err, out)
	}
	bad := exec.Command("go", "run", "../cmd/semanto-verify", "file", vec, "-keys", keys, "-pages", tampered)
	out, err = bad.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "FAIL page_bytes") {
		t.Fatalf("-pages after the path must be read and the tampered page caught: %v\n%s", err, out)
	}
}
