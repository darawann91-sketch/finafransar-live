// Streaming abstraction. The rest of the system only talks to this contract,
// so the vendor (LiveKit Cloud, self-hosted LiveKit, Amazon IVS, …) can be
// swapped by adding one adapter file + one client adapter in public/stream/.
//
// StreamingProvider {
//   name: string
//   createRoom(live): Promise<roomName>
//   hostCredentials(live, host): { provider, ...whatever the client adapter needs }
//   viewerCredentials(live, viewer{identity,name}, { guest }): { provider, ... }
//   stageCredentials(live, guest{identity,name}): { provider, ... }  // viewer invited on stage
//   removeViewer(live, identity): Promise<void>   // 10 s preview + taking guests off stage
//   endRoom(live): Promise<void>
// }
import { config } from '../config.js';
import { createLiveKitProvider } from './livekit.js';
import { createDevMeshProvider } from './devmesh.js';

export const hubRef = { current: null };

export function createStreaming() {
  const s = config.streaming;
  switch (s.provider) {
    case 'livekit':
      return createLiveKitProvider(s.livekit, s);
    case 'devmesh':
      return createDevMeshProvider(hubRef, s);
    default:
      throw new Error(`Okänd STREAM_PROVIDER: ${s.provider}`);
  }
}

export const streaming = createStreaming();
