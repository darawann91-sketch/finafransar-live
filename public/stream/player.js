// Viewer-side streaming adapters. Same contract for every provider:
//   const p = await createPlayer(creds, videoEl, { signal, vendor, onState })
//   p.startAudio(); p.disconnect();
// onState(state): 'connecting' | 'playing' | 'waiting' | 'reconnecting' | 'ended' | 'full' | 'error'

export async function createPlayer(creds, video, opts) {
  if (creds.provider === 'livekit') return livekitPlayer(creds, video, opts);
  if (creds.provider === 'devmesh') return meshPlayer(creds, video, opts);
  throw new Error('Unknown stream provider ' + creds.provider);
}

function watchVideo(video, onState) {
  const playing = () => onState('playing');
  const waiting = () => onState('waiting');
  video.addEventListener('playing', playing);
  video.addEventListener('waiting', waiting);
  return () => {
    video.removeEventListener('playing', playing);
    video.removeEventListener('waiting', waiting);
  };
}

async function safePlay(video) {
  try {
    await video.play();
  } catch {
    // Autoplay can still be refused (low power mode); keep muted and retry on first tap.
    video.muted = true;
    try { await video.play(); } catch {}
  }
}

// ---- LiveKit (production) -------------------------------------------------
async function livekitPlayer(creds, video, { vendor, onState }) {
  const LK = await import(vendor.livekit);
  const room = new LK.Room({ adaptiveStream: true, dynacast: true, stopLocalTrackOnUnpublish: true });
  const unwatch = watchVideo(video, onState);
  onState('connecting');

  room
    .on(LK.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === 'video' || track.kind === 'audio') {
        track.attach(video);
        safePlay(video);
      }
    })
    .on(LK.RoomEvent.TrackUnsubscribed, (track) => track.detach(video))
    .on(LK.RoomEvent.Reconnecting, () => onState('reconnecting'))
    .on(LK.RoomEvent.Reconnected, () => onState('playing'))
    .on(LK.RoomEvent.ParticipantDisconnected, (p) => {
      if (String(p.identity).startsWith('host-')) onState('waiting');
    })
    .on(LK.RoomEvent.Disconnected, () => onState('ended'));

  try {
    await room.connect(creds.url, creds.token, { autoSubscribe: true });
  } catch (e) {
    unwatch();
    const msg = String(e?.message || e);
    onState(/limit|capacity|full|participant/i.test(msg) ? 'full' : 'error');
    throw e;
  }
  return {
    async startAudio() {
      video.muted = false;
      try { await room.startAudio(); } catch {}
      await safePlay(video);
    },
    disconnect() {
      unwatch();
      room.disconnect();
    },
  };
}

// ---- Dev mesh (development only) ------------------------------------------
async function meshPlayer(creds, video, { signal, onState }) {
  let pc = null;
  const unwatch = watchVideo(video, onState);
  onState('connecting');

  const reset = () => {
    if (pc) pc.close();
    pc = new RTCPeerConnection({ iceServers: creds.iceServers || [] });
    pc.ontrack = (ev) => {
      if (video.srcObject !== ev.streams[0]) video.srcObject = ev.streams[0];
      safePlay(video);
    };
    pc.onicecandidate = (ev) => ev.candidate && signal.send({ t: 'rtc', data: { candidate: ev.candidate.toJSON() } });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') onState('waiting');
    };
  };

  const offRtc = signal.on('rtc', async (msg) => {
    const d = msg.data || {};
    if (d.sdp && d.sdp.type === 'offer') {
      reset();
      await pc.setRemoteDescription(d.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      signal.send({ t: 'rtc', data: { sdp: pc.localDescription.toJSON() } });
    } else if (d.candidate && pc) {
      try { await pc.addIceCandidate(d.candidate); } catch {}
    }
  });
  const join = () => signal.send({ t: 'mesh_join', identity: creds.identity });
  const offHost = signal.on('host_online', join);
  const offOpen = signal.on('open', join);
  join();

  return {
    async startAudio() {
      video.muted = false;
      await safePlay(video);
    },
    disconnect() {
      offRtc(); offHost(); offOpen(); unwatch();
      if (pc) pc.close();
      pc = null;
    },
  };
}
