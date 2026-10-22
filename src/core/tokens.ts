// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// A token estimate for the x-markdown-tokens and x-original-tokens headers,
// under the names Cloudflare's Markdown for Agents already uses, so an agent
// reading both gets the same header. It is an estimate: the common tokenizers
// average close to four characters per token on English prose and fewer on
// code and markup. The method is stated here and in the docs so nobody takes
// the number for a measurement from a specific model.

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const words = text.split(/\s+/).filter(Boolean).length;
  const chars = text.length;
  // Blend: prose tends to 0.75 tokens per word; markup tends to chars / 4.
  const byWords = words * 1.33;
  const byChars = chars / 4;
  return Math.max(1, Math.round((byWords + byChars) / 2));
}
