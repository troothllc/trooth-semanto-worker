// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Trooth, LLC
//
// RFC 6962 Merkle hashing: leaf SHA-256(0x00 || data), node SHA-256(0x01 ||
// left || right), inclusion proof check (2.1.3) and consistency proof check
// (2.1.4.2), the same ones every Certificate Transparency verifier uses.
package semanto

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
)

var digestRe = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// Digest is the printed form every Semanto digest uses: sha256: plus 64 hex.
func Digest(data []byte) string {
	s := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(s[:])
}

// IsDigest reports whether v is a printed digest.
func IsDigest(v any) bool {
	s, ok := v.(string)
	return ok && digestRe.MatchString(s)
}

// DigestBytes decodes a printed digest.
func DigestBytes(d string) ([]byte, error) {
	if !IsDigest(d) {
		return nil, fmt.Errorf(`expected "sha256:<64 hex>", got %q`, d)
	}
	return hex.DecodeString(d[7:])
}

// LeafHash is MTH({d}).
func LeafHash(data []byte) []byte {
	h := sha256.New()
	h.Write([]byte{0})
	h.Write(data)
	return h.Sum(nil)
}

// NodeHash is the interior node hash.
func NodeHash(left, right []byte) []byte {
	h := sha256.New()
	h.Write([]byte{1})
	h.Write(left)
	h.Write(right)
	return h.Sum(nil)
}

func largestPowerOfTwoBelow(n int) int {
	k := 1
	for k*2 < n {
		k *= 2
	}
	return k
}

// RootFromLeafHashes computes the tree root over already-hashed leaves.
func RootFromLeafHashes(leaves [][]byte) []byte {
	if len(leaves) == 0 {
		s := sha256.Sum256(nil)
		return s[:]
	}
	if len(leaves) == 1 {
		return leaves[0]
	}
	k := largestPowerOfTwoBelow(len(leaves))
	return NodeHash(RootFromLeafHashes(leaves[:k]), RootFromLeafHashes(leaves[k:]))
}

// VerifyInclusion recomputes the root from a leaf hash and its audit path.
func VerifyInclusion(leaf []byte, index, size int, proof [][]byte, expectedRoot []byte) bool {
	if index < 0 || index >= size {
		return false
	}
	fn, sn, r := index, size-1, leaf
	for _, p := range proof {
		if sn == 0 {
			return false
		}
		if fn%2 == 1 || fn == sn {
			r = NodeHash(p, r)
			for !(fn%2 == 1 || fn == 0) {
				fn >>= 1
				sn >>= 1
			}
		} else {
			r = NodeHash(r, p)
		}
		fn >>= 1
		sn >>= 1
	}
	return sn == 0 && bytes.Equal(r, expectedRoot)
}

// VerifyConsistencyProof shows the old tree is a prefix of the new tree.
func VerifyConsistencyProof(oldSize, newSize int, oldRoot, newRoot []byte, proof [][]byte) bool {
	if oldSize > newSize {
		return false
	}
	if oldSize == newSize {
		return len(proof) == 0 && bytes.Equal(oldRoot, newRoot)
	}
	if oldSize == 0 {
		return len(proof) == 0
	}
	isPow2 := oldSize&(oldSize-1) == 0
	var p [][]byte
	if isPow2 {
		p = make([][]byte, 0, len(proof)+1)
		p = append(p, oldRoot)
		for _, x := range proof {
			p = append(p, x)
		}
	} else {
		p = make([][]byte, len(proof))
		copy(p, proof)
	}
	if len(p) == 0 {
		return false
	}
	fn, sn := oldSize-1, newSize-1
	for fn%2 == 1 {
		fn >>= 1
		sn >>= 1
	}
	fr, sr := p[0], p[0]
	for _, c := range p[1:] {
		if sn == 0 {
			return false
		}
		if fn%2 == 1 || fn == sn {
			fr = NodeHash(c, fr)
			sr = NodeHash(c, sr)
			for !(fn%2 == 1 || fn == 0) {
				fn >>= 1
				sn >>= 1
			}
		} else {
			sr = NodeHash(sr, c)
		}
		fn >>= 1
		sn >>= 1
	}
	return sn == 0 && bytes.Equal(fr, oldRoot) && bytes.Equal(sr, newRoot)
}
