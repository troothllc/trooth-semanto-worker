# Semanto adapter for Apache httpd

One configuration file. `mod_rewrite` looks at the `Accept` header and the path suffix, `mod_proxy` fetches the signed copy from Trooth, and the API's headers come back to the reader unchanged. Nothing reads `User-Agent`.

## Install (Debian and Ubuntu)

```
sudo a2enmod rewrite proxy proxy_http ssl headers
sudo cp semanto.conf /etc/apache2/conf-available/semanto.conf
sudo sed -i 's/example-inc/your-trooth-id/g' /etc/apache2/conf-available/semanto.conf
# inside your <VirtualHost *:443> block:
#     Include conf-available/semanto.conf
sudo apachectl configtest && sudo systemctl reload apache2
```

Red Hat family: copy to `/etc/httpd/conf.d/`, the modules are loaded by default.

## In `.htaccess` instead

If you cannot edit the virtual host, the same rules work in a `.htaccess` file at the web root with two changes: drop the leading `/` from every `RewriteRule` pattern (`^\.well-known/trooth\.semanto$`), and ask your host to allow `mod_proxy` in `.htaccess` (`AllowOverride All` plus `ProxyRequests Off` at server level; most shared hosts do not allow it, in which case use the head tag adapter).

## What it serves

| Request | Answer |
| --- | --- |
| `/.well-known/trooth.semanto`, `/.well-known/trooth-keys.json` | Your Semanto file and public keys |
| `/llms.txt`, `/llms-full.txt`, `/sitemap.md` | The Trooth-built copies |
| Any path ending in `.md` or `/index.md`, or `Accept: text/markdown` or `text/*` | The signed markdown of that page, by its path |
| Any path ending in `.jsonld`, or `Accept: application/ld+json` | Your signed facts file |
| Everything else | Your site, with a `Link` header on HTML |

The Accept regular expressions match when the type appears before any `text/html` entry and is not `q=0`. `*/*` alone and a missing header go to your site. This gives the same answer as the exact algorithm for every row in the table in `adapters/README.md`.

## Modes

- `semanto_only`: the file as written.
- `proof_only`: delete the block between "semanto_only" and "end of pages" and the three llms rules.
- `semanto_then_cloudflare_for_unsigned` needs the manifest, which Apache does not read; use the Cloudflare Worker adapter if Cloudflare is in front.

## Check it worked

```
curl -sI https://yourdomain.com/.well-known/trooth.semanto | grep -i -E "signature|trooth"
curl -s -H "Accept: text/markdown" https://yourdomain.com/ | head
```
