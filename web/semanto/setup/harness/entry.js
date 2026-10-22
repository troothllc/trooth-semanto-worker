// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The harness page: renders SetupWizard against the mock setup API on the
// same origin, the way trooth-web will render it against api.trooth.co. The
// query string sets the session (token), the once-only passkey offer after an
// email link (fresh=1), an expired link (expired=<email>), a cancelled
// Domain Connect return (declined=1), the theme (theme=dark) and the poll
// schedule (poll=spec keeps the spec's 4 to 60 seconds; the default is a
// faster schedule so the walk finishes in seconds). Not shipped.

import { createRoot } from "react-dom/client";
import { SetupWizard, createSetupClient } from "../index";

const q = new URLSearchParams(location.search);
const token = q.get("token");
if (q.get("theme") === "dark") document.documentElement.setAttribute("data-theme", "dark");

const client = createSetupClient({ base: location.origin, token: () => token ?? "", timeoutMs: Number(q.get("timeout") ?? 15000) });
const guide = (id) => `/__guide/${id}`;
const install = Object.fromEntries(["cloudflare-worker", "vercel-middleware", "netlify-edge", "fastly-compute", "akamai-edgeworkers", "gcore-fastedge", "nginx-config", "apache-config", "wordpress-plugin", "shopify-app", "head-tag"].map((id) => [id, guide(id)]));

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

function App() {
  return (
    <SetupWizard
      client={client}
      apiBase="https://api.trooth.co"
      signedIn={!!token}
      signIn={{
        googleHref: "/__guide/google-sign-in",
        linkExpiredFor: q.get("expired"),
        async sendEmailLink(email) {
          const r = await fetch("/__harness/email-link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
          if (!r.ok) throw new Error("The sign-in link was not sent. Check your connection, then try again.");
          window.__lastLink = (await r.json()).link;
        },
      }}
      passkeyOffer={
        q.get("fresh") === "1"
          ? {
              async save() {
                const challenge = crypto.getRandomValues(new Uint8Array(32));
                const cred = await navigator.credentials.create({
                  publicKey: {
                    challenge,
                    rp: { name: "Trooth", id: location.hostname },
                    user: { id: new TextEncoder().encode("ada@acme.com"), name: "ada@acme.com", displayName: "Ada" },
                    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                    authenticatorSelection: { residentKey: "required", userVerification: "required" },
                    timeout: 10000,
                  },
                });
                if (!cred) throw new Error("no passkey");
                window.__passkeySaved = toB64(cred.rawId);
              },
              dismiss() {
                window.__passkeyDismissed = true;
              },
            }
          : null
      }
      links={{ help: guide("help"), monitoring: guide("monitoring"), handoff: guide("handoff"), keys: guide("keys"), install }}
      domainConnectDeclined={q.get("declined") === "1"}
      pollSchedule={q.get("poll") === "spec" ? undefined : [250, 500, 1000, 2000, 4000]}
    />
  );
}

createRoot(document.getElementById("root")).render(<App />);
