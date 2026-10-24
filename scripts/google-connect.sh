#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
# Copyright (c) 2026 Trooth, LLC
#
# Stores the Google OAuth client for Connect Google (Merchant Center and Business Profile) on the
# production Semanto Worker. It asks for the Client ID and the Client secret that Google Cloud
# Console shows when the client is made; the secret is read without echo and goes straight to
# Cloudflare through wrangler's stdin. Nothing is printed or written to disk.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null
read -r -p "Google OAuth Client ID: " CID
read -r -s -p "Google OAuth Client secret (hidden): " CSEC; echo
case "$CID" in *.apps.googleusercontent.com) ;; *) echo "That Client ID does not end in .apps.googleusercontent.com. Nothing was stored."; exit 1;; esac
[ -n "$CSEC" ] || { echo "The Client secret was empty. Nothing was stored."; exit 1; }
printf '%s' "$CID" | npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID --env production >/dev/null
printf '%s' "$CSEC" | npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET --env production >/dev/null
unset CID CSEC
echo "Stored. Connect Google now opens Google's consent screen from the Semanto dashboard."
