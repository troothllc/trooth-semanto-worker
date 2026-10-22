#!/bin/sh
# SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
# Copyright (c) 2026 Trooth, LLC
#
# Builds the EdgeWorkers bundle: main.js, bundle.json and a copy of the shared
# modules (the adapter and the forwarding signer it imports), in one tarball
# ready for `akamai edgeworkers upload`.
set -e
cd "$(dirname "$0")"
cp ../shared/semanto-adapter.mjs ./semanto-adapter.mjs
cp ../shared/sign-request.mjs ./sign-request.mjs
tar -czvf trooth-semanto-edgeworker.tgz main.js bundle.json semanto-adapter.mjs sign-request.mjs
echo "wrote trooth-semanto-edgeworker.tgz"
