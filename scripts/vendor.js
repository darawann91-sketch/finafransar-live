// Copies the LiveKit browser SDK into public/vendor so it is self-hosted
// (no third-party CDN on the live page). Runs automatically after npm install.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

const src = 'node_modules/livekit-client/dist/livekit-client.esm.mjs';
const dst = 'public/vendor/livekit-client.esm.mjs';
mkdirSync('public/vendor', { recursive: true });
if (existsSync(src)) {
  copyFileSync(src, dst);
  console.log('livekit-client -> public/vendor ✓');
} else {
  console.warn('livekit-client saknas i node_modules – kör "npm install" (krävs för STREAM_PROVIDER=livekit).');
}
