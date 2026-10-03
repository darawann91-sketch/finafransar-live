// Viewer-side streaming adapters. Same contract for every provider:
//   const p = await createPlayer(creds, videoEl, { signal, vendor, onState, layout?, publish? })
//   p.startAudio(); p.disconnect();  (+ setMicEnabled / replaceVideoTrack when publishing)
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
// Handles the host plus any guests on stage. With `layout` every camera is
// routed through the layout engine (big + small tiles); with `publish`
// (a MediaStream) this client is itself a guest on stage and sends its camera.
async function livekitPlayer(creds, video, { vendor, onState, layout, publish }) {
  const LK = await import(vendor.livekit);
  const room = new LK.Room({ adaptiveStream: true, dynacast: true, stopLocalTrackOnUnpublish: true });
  const unwatch = watchVideo(video, onState);
  const audioEls = new Map(); // track sid -> element
  let audioOn = !video.muted;
  onState('connecting');

  const wrap = (track) => ({
    attach(el) { track.attach(el); safePlay(el); },
    detach(el) { track.detach(el); },
  });
  const isHost = (p) => String(p?.identity || '').startsWith('host-');

  room
    .on(LK.RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind === 'video') {
        if (layout) layout.set(participant.identity, { video: wrap(track), name: participant.name || '' });
        else if (isHost(participant)) { track.attach(video); safePlay(video); }
      } else if (track.kind === 'audio') {
        const el = track.attach();
        el.muted = !audioOn;
        el.style.display = 'none';
        el.dataset.identity = participant.identity;
        document.body.append(el);
        audioEls.set(track.sid, el);
        if (audioOn) el.play?.().catch(() => {});
      }
    })
    .on(LK.RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
      if (track.kind === 'video') {
        if (layout) layout.set(participant.identity, { video: null });
        else track.detach(video);
      } else {
        const el = audioEls.get(track.sid);
        if (el) { track.detach(el); el.remove(); audioEls.delete(track.sid); }
      }
    })
    .on(LK.RoomEvent.ParticipantDisconnected, (p) => {
      layout?.remove(p.identity);
      if (isHost(p)) onState('waiting');
    })
    .on(LK.RoomEvent.Reconnecting, () => onState('reconnecting'))
    .on(LK.RoomEvent.Reconnected, () => onState('playing'))
    .on(LK.RoomEvent.Disconnected, () => onState('ended'));

  try {
    await room.connect(creds.url, creds.token, { autoSubscribe: true });
  } catch (e) {
    unwatch();
    const msg = String(e?.message || e);
    onState(/limit|capacity|full|participant/i.test(msg) ? 'full' : 'error');
    throw e;
  }

  // Guest on stage: send our own camera + mic.
  const local = {};
  if (publish) {
    const v = publish.getVideoTracks()[0];
    const a = publish.getAudioTracks()[0];
    try {
      if (v) local.video = await room.localParticipant.publishTrack(v, { source: LK.Track.Source.Camera, simulcast: true, videoCodec: 'vp8' });
      if (a) local.audio = await room.localParticipant.publishTrack(a, { source: LK.Track.Source.Microphone, dtx: true, red: true });
    } catch (e) {
      room.disconnect();
      unwatch();
      throw e;
    }
    if (v && layout) layout.set(room.localParticipant.identity, { video: wrapLocal(v), name: 'Du', mirror: true });
  }

  return {
    identity: room.localParticipant?.identity,
    async startAudio() {
      audioOn = true;
      video.muted = false;
      for (const el of audioEls.values()) { el.muted = false; el.play?.().catch(() => {}); }
      try { await room.startAudio(); } catch {}
      await safePlay(video);
    },
    async setMicEnabled(on) {
      const t = local.audio?.track;
      if (t) on ? await t.unmute() : await t.mute();
    },
    async replaceVideoTrack(track) {
      await local.video?.track?.replaceTrack(track);
      if (layout && track) layout.set(room.localParticipant.identity, { video: wrapLocal(track) });
    },
    disconnect() {
      unwatch();
      for (const el of audioEls.values()) el.remove();
      audioEls.clear();
      layout?.clear();
      room.disconnect();
    },
  };
}

function wrapLocal(mediaTrack) {
  return {
    attach(el) { el.srcObject = new MediaStream([mediaTrack]); safePlay(el); },
    detach(el) { el.srcObject = null; },
  };
}

// ---- Dev mesh (development only) ------------------------------------------
async function meshPlayer(creds, video, { signal, onState, layout, publish }) {
  if (publish) {
    // Dev mesh can't relay a guest's camera; show it locally so the UI can be developed.
    const v = publish.getVideoTracks()[0];
    if (v && layout) layout.set(creds.identity || 'local-guest', { video: wrapLocal(v), name: 'Du', mirror: true });
  }
  let pc = null;
  const unwatch = watchVideo(video, onState);
  onState('connecting');

  const reset = () => {
    if (pc) pc.close();
    pc = new RTCPeerConnection({ iceServers: creds.iceServers || [] });
    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (layout) {
        layout.set('host-mesh', { video: { attach(el) { el.srcObject = stream; safePlay(el); }, detach(el) { el.srcObject = null; } }, name: '' });
        return;
      }
      if (video.srcObject !== stream) video.srcObject = stream;
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
      layout?.clear();
    },
  };
}
