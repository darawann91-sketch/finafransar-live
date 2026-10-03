// Host-side streaming adapters (Live Studio).
//   const pub = await createPublisher(creds, mediaStream, { signal, vendor, onState })
//   pub.replaceVideoTrack(track); pub.replaceAudioTrack(track); pub.setMicEnabled(bool); pub.stop()

export async function createPublisher(creds, stream, opts) {
  if (creds.provider === 'livekit') return livekitPublisher(creds, stream, opts);
  if (creds.provider === 'devmesh') return meshPublisher(creds, stream, opts);
  throw new Error('Unknown stream provider ' + creds.provider);
}

// ---- LiveKit ----------------------------------------------------------------
async function livekitPublisher(creds, stream, { vendor, onState }) {
  const LK = await import(vendor.livekit);
  const room = new LK.Room({ dynacast: true });
  room
    .on(LK.RoomEvent.Reconnecting, () => onState('reconnecting'))
    .on(LK.RoomEvent.Reconnected, () => onState('live'))
    .on(LK.RoomEvent.Disconnected, () => onState('disconnected'));
  onState('connecting');
  await room.connect(creds.url, creds.token);

  const p = creds.publish || {};
  const vTrack = stream.getVideoTracks()[0];
  const aTrack = stream.getAudioTracks()[0];
  const settings = vTrack?.getSettings?.() || {};
  const w = settings.width || 1080;
  const h = settings.height || 1920;
  const layers = (p.simulcast || []).map((l) => {
    // keep the camera's aspect ratio; "height" in the ladder means the short side
    const scale = l.height / Math.min(w, h);
    return new LK.VideoPreset(Math.round(w * scale), Math.round(h * scale), l.maxBitrate, l.maxFramerate);
  });

  const pubs = {};
  if (vTrack) {
    pubs.video = await room.localParticipant.publishTrack(vTrack, {
      source: LK.Track.Source.Camera,
      simulcast: true,
      videoEncoding: { maxBitrate: p.maxBitrate || 4_500_000, maxFramerate: p.maxFramerate || 30 },
      videoSimulcastLayers: layers,
      degradationPreference: 'maintain-framerate',
    });
  }
  if (aTrack) {
    pubs.audio = await room.localParticipant.publishTrack(aTrack, {
      source: LK.Track.Source.Microphone,
      dtx: false,
      red: true,
      audioPreset: LK.AudioPresets?.musicHighQuality,
    });
  }
  onState('live');

  return {
    async replaceVideoTrack(track) {
      await pubs.video?.track?.replaceTrack(track);
    },
    async replaceAudioTrack(track) {
      await pubs.audio?.track?.replaceTrack(track);
    },
    async setMicEnabled(on) {
      if (!pubs.audio?.track) return;
      on ? await pubs.audio.track.unmute() : await pubs.audio.track.mute();
    },
    stop() {
      room.disconnect(false);
    },
  };
}

// ---- Dev mesh (development only) --------------------------------------------
async function meshPublisher(creds, stream, { signal, onState }) {
  const peers = new Map(); // viewerConnId -> RTCPeerConnection
  let current = stream;
  const p = creds.publish || {};

  async function offerTo(id) {
    peers.get(id)?.close();
    const pc = new RTCPeerConnection({ iceServers: creds.iceServers || [] });
    peers.set(id, pc);
    for (const t of current.getTracks()) {
      const sender = pc.addTrack(t, current);
      if (t.kind === 'video') {
        const params = sender.getParameters();
        params.encodings = [{ maxBitrate: p.maxBitrate || 4_500_000, maxFramerate: p.maxFramerate || 30 }];
        sender.setParameters(params).catch(() => {});
      }
    }
    pc.onicecandidate = (ev) => ev.candidate && signal.send({ t: 'rtc', to: id, data: { candidate: ev.candidate.toJSON() } });
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        pc.close();
        if (peers.get(id) === pc) peers.delete(id);
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signal.send({ t: 'rtc', to: id, data: { sdp: pc.localDescription.toJSON() } });
  }

  const offs = [
    signal.on('mesh_viewer', (m) => offerTo(m.from).catch(console.error)),
    signal.on('mesh_drop', (m) => {
      peers.get(m.id)?.close();
      peers.delete(m.id);
    }),
    signal.on('rtc', async (m) => {
      const pc = peers.get(m.from);
      if (!pc) return;
      const d = m.data || {};
      if (d.sdp && d.sdp.type === 'answer') await pc.setRemoteDescription(d.sdp).catch(() => {});
      else if (d.candidate) await pc.addIceCandidate(d.candidate).catch(() => {});
    }),
  ];
  onState('live');

  const replace = async (kind, track) => {
    for (const pc of peers.values()) {
      const s = pc.getSenders().find((x) => x.track?.kind === kind);
      if (s) await s.replaceTrack(track);
    }
  };
  return {
    peers,
    async replaceVideoTrack(track) {
      await replace('video', track);
    },
    async replaceAudioTrack(track) {
      await replace('audio', track);
    },
    async setMicEnabled(on) {
      current.getAudioTracks().forEach((t) => (t.enabled = on));
    },
    setStream(s) {
      current = s;
    },
    stop() {
      offs.forEach((f) => f());
      for (const pc of peers.values()) pc.close();
      peers.clear();
    },
  };
}
