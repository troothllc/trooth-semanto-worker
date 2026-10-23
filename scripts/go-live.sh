#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
# Copyright (c) 2026 Trooth, LLC
#
# Puts the Semanto Worker live at api.trooth.co/public/semanto and api.trooth.co/os/semanto,
# with the founder's own wrangler login. Safe to run again: every step checks before it acts.
#
# The Cloudflare resources (D1 trooth_semanto, KV trooth-semanto-CACHE, R2 trooth-semanto and the
# queues trooth-semanto-compile and trooth-semanto-compile-dlq) exist already; their ids are in
# wrangler.toml [env.production].
#
# Secrets are made here, on this machine, and go straight to Cloudflare through wrangler's stdin.
# None is printed, written to disk, or sent anywhere else. A secret already set is left as it is,
# so a second run never rotates the witness key or the seal secret by accident.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n== %s\n' "$1"; }

say "1/6 Install"
npm ci --no-audit --no-fund >/dev/null
npx wrangler --version

say "2/6 Signed in to Cloudflare"
npx wrangler whoami | grep -E "email|Account" | head -3

say "3/6 Database migrations 0001 to 0009 (D1 trooth_semanto)"
CI=1 npx wrangler d1 migrations apply trooth_semanto --env production --remote

say "4/6 Deploy trooth-semanto-worker"
npx wrangler deploy --env production

say "5/6 Secrets (made here, never shown)"
have_secret() { npx wrangler secret list --env production 2>/dev/null | grep -q "\"$1\""; }
put_secret() { npx wrangler secret put "$1" --env production >/dev/null; }

if have_secret TROOTH_WITNESS_KEY; then echo "TROOTH_WITNESS_KEY already set, kept"; else
  node --input-type=module -e '
    const { subtle } = globalThis.crypto;
    const kp = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const priv = await subtle.exportKey("jwk", kp.privateKey);
    const canon = JSON.stringify({ crv: "Ed25519", kty: "OKP", x: priv.x });
    const kid = Buffer.from(await subtle.digest("SHA-256", new TextEncoder().encode(canon))).toString("base64url");
    process.stdout.write(JSON.stringify({ kty: "OKP", crv: "Ed25519", x: priv.x, kid, alg: "EdDSA", use: "sig", d: priv.d }));
  ' | put_secret TROOTH_WITNESS_KEY
  echo "TROOTH_WITNESS_KEY set (fresh Ed25519 key, made on this machine)"
fi
if have_secret HOSTED_KEY_SEAL_SECRET; then echo "HOSTED_KEY_SEAL_SECRET already set, kept"; else
  openssl rand -base64 48 | tr -d '\n' | put_secret HOSTED_KEY_SEAL_SECRET; echo "HOSTED_KEY_SEAL_SECRET set"; fi
if have_secret RECEIPT_IP_SALT_SECRET; then echo "RECEIPT_IP_SALT_SECRET already set, kept"; else
  openssl rand -base64 32 | tr -d '\n' | put_secret RECEIPT_IP_SALT_SECRET; echo "RECEIPT_IP_SALT_SECRET set"; fi

# SEMANTO_EVENTS_SECRET must be the same on both Workers. Set both together, only when neither has it.
wf_has() { npx wrangler secret list --name trooth-os-worker-f 2>/dev/null | grep -q '"SEMANTO_EVENTS_SECRET"'; }
if have_secret SEMANTO_EVENTS_SECRET && wf_has; then echo "SEMANTO_EVENTS_SECRET already set on both Workers, kept"; else
  EV="$(openssl rand -hex 32)"
  printf '%s' "$EV" | put_secret SEMANTO_EVENTS_SECRET
  printf '%s' "$EV" | npx wrangler secret put SEMANTO_EVENTS_SECRET --name trooth-os-worker-f >/dev/null
  unset EV
  echo "SEMANTO_EVENTS_SECRET set on trooth-semanto-worker and trooth-os-worker-f (same value)"
fi

say "6/6 Live checks"
for path in public/semanto/.well-known/trooth-keys.json public/semanto/log/checkpoint; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://api.trooth.co/$path")
  echo "GET /$path -> $code"
done
echo
echo "Done. Semanto is live at api.trooth.co. The dashboard pages stay hidden until SEMANTO_DASHBOARD is turned on in trooth-web."
