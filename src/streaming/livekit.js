// LiveKit adapter (LiveKit Cloud or self-hosted LiveKit – same API).
// Implements the StreamingProvider contract described in ./index.js.
// No SDK needed server-side: access tokens are standard HS256 JWTs and the
// RoomService is a plain Twirp/JSON HTTP API.
import { signJwt } from '../lib/crypto.js';

export function createLiveKitProvider(cfg, streamCfg) {
  const { url, apiKey, apiSecret } = cfg;
  const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '');

  const token = (identity, name, grant, ttlSec, metadata) =>
    signJwt(
      { iss: apiKey, sub: identity, name, video: grant, metadata: metadata ? JSON.stringify(metadata) : undefined },
      apiSecret,
      { expiresInSec: ttlSec, notBefore: Math.floor(Date.now() / 1000) - 10 }
    );

  async function roomService(method, body, grant) {
    const auth = token('finafransar-live-server', 'server', grant, 60);
    const res = await fetch(`${httpUrl}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      // "not found" is fine for remove/delete (participant already gone).
      if (res.status === 404 || /not.?found/i.test(text)) return null;
      throw new Error(`LiveKit ${method} failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  return {
    name: 'livekit',

    async createRoom(live) {
      const room = `live-${live.id}`;
      await roomService('CreateRoom', { name: room, empty_timeout: 600, departure_timeout: 120 }, { roomCreate: true });
      return room;
    },

    hostCredentials(live, host) {
      return {
        provider: 'livekit',
        url,
        room: live.stream_room,
        token: token(`host-${host.id}`, host.name, {
          room: live.stream_room, roomJoin: true, canPublish: true, canSubscribe: false, canPublishData: false,
        }, 6 * 3600, { role: 'host' }),
        publish: publishSettings(streamCfg),
      };
    },

    viewerCredentials(live, viewer, { guest }) {
      return {
        provider: 'livekit',
        url,
        room: live.stream_room,
        token: token(viewer.identity, viewer.name || 'Tittare', {
          room: live.stream_room, roomJoin: true, canPublish: false, canSubscribe: true, canPublishData: false, hidden: true,
        }, guest ? 60 : 8 * 3600),
      };
    },

    async removeViewer(live, identity) {
      await roomService('RemoveParticipant', { room: live.stream_room, identity }, { roomAdmin: true, room: live.stream_room });
    },

    async endRoom(live) {
      if (!live.stream_room) return;
      await roomService('DeleteRoom', { room: live.stream_room }, { roomCreate: true });
    },
  };
}

// Encoding ladder shared with the client. Top layer = configured max.
export function publishSettings(streamCfg) {
  const h = Math.min(Math.max(streamCfg.maxHeight || 1080, 720), 2160);
  return {
    maxHeight: h,
    maxBitrate: (streamCfg.maxBitrateKbps || 4500) * 1000,
    maxFramerate: 30,
    // Lower simulcast layers so weak connections never stall.
    simulcast: [
      { height: 360, maxBitrate: 450_000, maxFramerate: 30 },
      { height: 720, maxBitrate: 1_700_000, maxFramerate: 30 },
    ],
  };
}
