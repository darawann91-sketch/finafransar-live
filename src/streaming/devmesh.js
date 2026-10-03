// DEV-ONLY streaming adapter: the host's browser sends WebRTC directly to
// each viewer, signalled through our own websocket. Handles a handful of
// viewers – it exists so the whole system can be developed and tested
// end-to-end without a LiveKit account, and to prove the streaming layer is
// swappable. Never use in production (config refuses it).
import { publishSettings } from './livekit.js';

export function createDevMeshProvider(hubRef, streamCfg) {
  return {
    name: 'devmesh',
    async createRoom(live) {
      return `mesh-${live.id}`;
    },
    hostCredentials(live) {
      return { provider: 'devmesh', room: live.stream_room, iceServers: [], publish: publishSettings(streamCfg) };
    },
    viewerCredentials(live) {
      return { provider: 'devmesh', room: live.stream_room, iceServers: [] };
    },
    // Dev mesh is one-to-many from the host only: guests can't be relayed.
    stageCredentials(live) {
      return { provider: 'devmesh', room: live.stream_room, unsupported: true };
    },
    async removeViewer(live, identity) {
      hubRef.current?.meshDropViewer(live.id, identity);
    },
    async endRoom() {},
  };
}
