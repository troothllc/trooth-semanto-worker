#!/bin/sh
# SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
# Copyright (c) 2026 Trooth, LLC
#
# Builds the EdgeWorkers bundle: main.js, bundle.json and a copy of the shared
# module, in one tarball ready for `akamai edgeworkers upload`.
set -e
cd "$(dirname "$0")"
cp ../shared/semanto-adapter.mjs ./semanto-adapter.mjs
tar -czvf trooth-semanto-edgeworker.tgz main.js bundle.json semanto-adapter.mjs
echo "wrote trooth-semanto-edgeworker.tgz"
