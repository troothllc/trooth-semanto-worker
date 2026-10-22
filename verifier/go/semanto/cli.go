// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Command-line helpers shared by cmd/semanto-verify: flags are read anywhere
// on the line, before or after the file path or url, the way the JavaScript
// and Python command lines read them (Go's flag package stops at the first
// positional argument, so the remaining words are parsed again in turn).
package semanto

import "flag"

// ParseInterspersed parses flags that appear anywhere in args and returns the
// positional arguments in order. A "--" ends flag parsing; every word after it
// is positional.
func ParseInterspersed(fs *flag.FlagSet, args []string) ([]string, error) {
	var positional []string
	for {
		if err := fs.Parse(args); err != nil {
			return positional, err
		}
		rest := fs.Args()
		if len(rest) == 0 {
			return positional, nil
		}
		// fs.Parse consumed a "--" when the word before rest is "--": everything after it is positional.
		consumed := len(args) - len(rest)
		if consumed > 0 && args[consumed-1] == "--" {
			for _, w := range rest {
				positional = append(positional, w)
			}
			return positional, nil
		}
		positional = append(positional, rest[0])
		args = rest[1:]
	}
}
