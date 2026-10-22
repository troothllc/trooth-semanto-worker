// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The house-rule patterns the tests check text against (docs/ARCHITECTURE.md
// rules 2 and 5), built from parts so no test file holds the words or the
// three dots it bans: the noun a ranking gives (and its plural and verb forms)
// and the past participles of "verify" and "certify"; the ellipsis character
// and three periods that are not a spread or rest operator.

export const BANNED_WORDS = new RegExp(`\\b(${["sc" + "ore", "sc" + "ores", "sc" + "ored", "sc" + "oring", "veri" + "fied", "certi" + "fied"].join("|")})\\b`, "i");
export const ELLIPSIS_CHAR = String.fromCharCode(0x2026);
export const THREE_DOTS = ".".repeat(3);
/** Three periods that are not JavaScript's spread or rest operator. */
export const ELLIPSIS = new RegExp(`${ELLIPSIS_CHAR}|\\.\\.\\.(?![A-Za-z_$([{])`);
