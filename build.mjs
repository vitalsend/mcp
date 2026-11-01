// Bundles the package, the crypto core (frontend/src/js/crypto, the code
// vitalsend.eu ships) and the page into one file; npm dependencies stay
// external and install with the package.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.js'],
  outfile: 'dist/vitalsend-mcp.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  packages: 'external',
  loader: { '.html': 'text' },
  banner: { js: '#!/usr/bin/env node\n// SPDX-License-Identifier: AGPL-3.0-or-later' },
});
