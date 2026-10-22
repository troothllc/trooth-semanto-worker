// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Package semanto checks Semanto by Trooth files, page proofs, signed
// responses and the public log with the Go standard library only. This file
// is RFC 8785 (JSON Canonicalization Scheme): member names sorted by UTF-16
// code units, the shortest escapes, integers printed as they are. Semanto
// never signs a non-integer number; one is an error here, not a guess.
package semanto

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// Canonicalize returns the RFC 8785 text of a value decoded from JSON
// (map[string]any, []any, string, bool, nil, json.Number, float64 or an
// integer type).
func Canonicalize(v any) (string, error) {
	var b strings.Builder
	if err := canon(&b, v); err != nil {
		return "", err
	}
	return b.String(), nil
}

// CanonicalBytes is Canonicalize as UTF-8 bytes.
func CanonicalBytes(v any) ([]byte, error) {
	s, err := Canonicalize(v)
	return []byte(s), err
}

// MustCanonicalize panics on values Semanto never signs; use it only on values
// already decoded from JSON text.
func MustCanonicalize(v any) string {
	s, err := Canonicalize(v)
	if err != nil {
		panic(err)
	}
	return s
}

func canon(b *strings.Builder, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case json.Number:
		s := string(x)
		if strings.ContainsAny(s, ".eE") {
			f, err := x.Float64()
			if err != nil {
				return fmt.Errorf("canonicalize: bad number %q", s)
			}
			return canonFloat(b, f)
		}
		if s == "-0" {
			s = "0"
		}
		b.WriteString(s)
	case float64:
		return canonFloat(b, x)
	case float32:
		return canonFloat(b, float64(x))
	case int:
		b.WriteString(strconv.FormatInt(int64(x), 10))
	case int64:
		b.WriteString(strconv.FormatInt(x, 10))
	case int32:
		b.WriteString(strconv.FormatInt(int64(x), 10))
	case uint:
		b.WriteString(strconv.FormatUint(uint64(x), 10))
	case uint64:
		b.WriteString(strconv.FormatUint(x, 10))
	case string:
		writeJSONString(b, x)
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := canon(b, e); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case []string:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSONString(b, e)
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return lessUTF16(keys[i], keys[j]) })
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSONString(b, k)
			b.WriteByte(':')
			if err := canon(b, x[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("canonicalize: cannot serialize %T", v)
	}
	return nil
}

func canonFloat(b *strings.Builder, f float64) error {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return fmt.Errorf("canonicalize: non-finite number")
	}
	if f == math.Trunc(f) && math.Abs(f) < 1<<53 {
		if f == 0 {
			b.WriteString("0")
			return nil
		}
		b.WriteString(strconv.FormatInt(int64(f), 10))
		return nil
	}
	return fmt.Errorf("canonicalize: %v is not an integer; Semanto signs integers only (use minor units or a string)", f)
}

// lessUTF16 orders strings by their UTF-16 code units, as RFC 8785 requires.
func lessUTF16(a, b string) bool {
	ua := utf16.Encode([]rune(a))
	ub := utf16.Encode([]rune(b))
	n := len(ua)
	if len(ub) < n {
		n = len(ub)
	}
	for i := 0; i < n; i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

func writeJSONString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

// DecodeJSON decodes JSON text keeping numbers as json.Number, so integers
// above 2^53 and the exact source text survive to Canonicalize.
func DecodeJSON(data []byte, into any) error {
	d := json.NewDecoder(strings.NewReader(string(data)))
	d.UseNumber()
	return d.Decode(into)
}
