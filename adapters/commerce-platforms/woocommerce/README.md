# WooCommerce

The WordPress plugin in `adapters/wordpress-plugin/` does this. It hooks product and variation changes, builds the same catalog document the scripts here build, signs it with a key made on the site, and POSTs it to `{TROOTH_API_BASE}/os/semanto/{trooth_id}/commerce/catalog`. The settings page shows the public key to paste into the Trooth dashboard and a "Send products now" button. Nothing to install from this folder.
