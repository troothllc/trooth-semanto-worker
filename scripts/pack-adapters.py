#!/usr/bin/env python3
# Builds the adapter packages trooth-web serves under /downloads/semanto: each
# adapter folder with adapters/shared, zipped with fixed dates so the same
# source gives the same bytes, and prints their sha256. The WordPress zip holds
# the plugin folder at its top, as WordPress installs it. Every other zip opens
# on START-HERE.txt, which says the files are not to be opened and where the
# steps are. Type declarations (.d.mts) ship only where a build type checks
# (Vercel's Next.js build): elsewhere they are unused, and macOS opens .mts in
# QuickTime.
#
#   python3 scripts/pack-adapters.py adapters ../trooth-web/public/downloads/semanto

import zipfile, os, sys, hashlib, json
src = sys.argv[1]; out = sys.argv[2]
os.makedirs(out, exist_ok=True)
PKG = {
  "cloudflare-worker": ["cloudflare-worker"],
  "vercel-middleware": ["vercel"],
  "netlify-edge": ["netlify"],
  "fastly-compute": ["fastly-compute"],
  "akamai-edgeworkers": ["akamai-edgeworkers"],
  "gcore-fastedge": ["gcore-fastedge"],
  "nginx-config": ["nginx"],
  "apache-config": ["apache"],
  "wordpress-plugin": ["wordpress-plugin"],
  "head-tag": ["head-tag"],
}
HOST = {"cloudflare-worker":"Cloudflare","vercel-middleware":"Vercel","netlify-edge":"Netlify","fastly-compute":"Fastly","akamai-edgeworkers":"Akamai","gcore-fastedge":"Gcore","nginx-config":"nginx","apache-config":"Apache","head-tag":"any host"}
TYPES = {"vercel-middleware"}
SHARED = {"cloudflare-worker","vercel-middleware","netlify-edge","fastly-compute","akamai-edgeworkers","gcore-fastedge"}
manifest = {}
for gid, dirs in PKG.items():
    files = []
    for d in dirs + (["shared"] if gid in SHARED else []):
        for root, _, names in os.walk(os.path.join(src, d)):
            for n in names:
                if n in ("node_modules",) or n.endswith(".tgz"): continue
                if n.endswith(".d.mts") and gid not in TYPES: continue
                files.append(os.path.relpath(os.path.join(root, n), src))
    files.sort()
    path = os.path.join(out, f"trooth-semanto-{gid}.zip")
    prefix = lambda f: f"trooth-semanto-{gid}/{f}"
    if gid == "wordpress-plugin":
        # WordPress installs a zip whose top folder is the plugin itself.
        files = [f for f in files if f.startswith("wordpress-plugin/trooth-semanto/")]
        prefix = lambda f: f[len("wordpress-plugin/"):]
    extra = {}
    if gid != "wordpress-plugin":
        extra["START-HERE.txt"] = (f"Semanto by Trooth for {HOST[gid]}\r\n\r\n"
            "You do not need to open the other files in this folder.\r\n\r\n"
            f"The steps are at https://trooth.co/docs/semanto/install/{gid}\r\n\r\n"
            "If someone else looks after your website, send them that link and this folder.\r\n").encode()
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, body in extra.items():
            zi = zipfile.ZipInfo(prefix(name), date_time=(2026,10,29,0,0,0))
            zi.external_attr = 0o644 << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, body)
        for f in files:
            zi = zipfile.ZipInfo(prefix(f), date_time=(2026,10,29,0,0,0))
            zi.external_attr = (0o755 if f.endswith(".sh") else 0o644) << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, open(os.path.join(src, f), "rb").read())
    manifest[gid] = {"file": os.path.basename(path), "sha256": hashlib.sha256(open(path,"rb").read()).hexdigest(), "bytes": os.path.getsize(path), "files": len(files) + len(extra)}
print(json.dumps(manifest, indent=1))
