// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The package bundles two sources it does not own: the crypto core and the
// share texts. In the VitalSend repo they are copied from frontend/ into
// vendor/ before every test and build, so they stay byte-identical; the
// public mirror ships vendor/ as is, and then there is nothing to copy.
import { cp, mkdir, rm, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = join(here, '..', 'frontend', 'src', 'js');
const vendor = join(here, 'vendor');

try {
  await access(frontend);
} catch (_err) {
  process.exit(0); // the public mirror: vendor/ is already there
}
await rm(vendor, { recursive: true, force: true });
await mkdir(vendor, { recursive: true });
await cp(join(frontend, 'crypto'), join(vendor, 'crypto'), {
  recursive: true,
  filter: (src) => !/\.test\.js$|\/fixtures(\/|$)|\/worker(\/|$)/.test(src),
});
await cp(join(frontend, 'vitalsend-share.js'), join(vendor, 'vitalsend-share.js'));
