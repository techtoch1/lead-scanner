// Starts the newest version sent with a direct deploy (<data>/current), or the
// installed copy next to this file if there isn't one or it fails to load.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dataDir = process.env.STATE_DIRECTORY || process.env.DATA_DIR;
const deployed = dataDir && path.join(dataDir, 'current', 'server', 'server.js');

if (deployed && fs.existsSync(deployed)) {
  try {
    await import(pathToFileURL(deployed).href);
  } catch (e) {
    console.error('Deployed version failed to load, starting the installed one instead:', e);
    await import('./server.js');
  }
} else {
  await import('./server.js');
}
