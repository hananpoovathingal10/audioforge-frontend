/* =====================================================
   NEBULA — Web Audio Engine with EQ + Pitch + Speed
   v6 — Louder gain (4x), voice compressor, 5-band EQ, accurate settings
   ===================================================== */

class AudioEngine {
  constructor() {
    this.ctx          = null;
    this.analyser     = null;
    this.source       = null;
    this.gainNode     = null;
    this.masterGain   = null;   // post-gain master volume
    this.bassFilter   = null;
    this.midFilter    = null;
    this.trebleFilter = null;
    this.presenceFilter = null; // presence band 3–6kHz
    this.airFilter    = null;   // air band 8–16kHz
    this.compressor   = null;   // optional voice compressor
    this.limiter      = null;   // soft knee limiter on output
    this.freqData     = null;
    this.audioBuffer  = null;
    this.micStream    = null;
    this.micSource    = null;
    this.micPreAmp    = null;
    this.recordDest   = null;

    this.isPlaying = false;
    this.isMic     = false;
    this.startedAt = 0;
    this.pausedAt  = 0;
    this.duration  = 0;
    this.volume    = 0.85;

    this.pitchSemitones = 0;
    this.playbackSpeed  = 1;

    this.bass     = 0;
    this.mid      = 0;
    this.treble   = 0;
    this.presence = 0;
    this.air      = 0;

    this.compressorEnabled  = false;
    this.compressorRatio    = 4;
    this.compressorThreshold= -24;
    this.compressorKnee     = 6;

    this.FFT_SIZE = 2048;
    this._onEnded = null;

    this.isRecording    = false;
    this.mediaRecorder  = null;
    this.recordedChunks = [];
  }

  async init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();

    // ── Analyser ────────────────────────────────────────
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.76;
    this.analyser.minDecibels = -100;
    this.analyser.maxDecibels = -10;

    // ── EQ filters (wider, more musical Q values) ─────
    this.bassFilter = this.ctx.createBiquadFilter();
    this.bassFilter.type = 'lowshelf';
    this.bassFilter.frequency.value = 100;   // warm low-end
    this.bassFilter.gain.value = 0;

    this.midFilter = this.ctx.createBiquadFilter();
    this.midFilter.type = 'peaking';
    this.midFilter.frequency.value = 800;    // vocal body
    this.midFilter.Q.value = 0.8;
    this.midFilter.gain.value = 0;

    this.trebleFilter = this.ctx.createBiquadFilter();
    this.trebleFilter.type = 'peaking';
    this.trebleFilter.frequency.value = 5000; // vocal brilliance
    this.trebleFilter.Q.value = 0.7;
    this.trebleFilter.gain.value = 0;

    this.presenceFilter = this.ctx.createBiquadFilter();
    this.presenceFilter.type = 'peaking';
    this.presenceFilter.frequency.value = 3500; // vocal presence / consonants
    this.presenceFilter.Q.value = 1.0;
    this.presenceFilter.gain.value = 0;

    this.airFilter = this.ctx.createBiquadFilter();
    this.airFilter.type = 'highshelf';
    this.airFilter.frequency.value = 12000;  // air, sparkle
    this.airFilter.gain.value = 0;

    // ── Voice Compressor (bypassed by default) ────────
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = this.compressorThreshold;
    this.compressor.knee.value      = this.compressorKnee;
    this.compressor.ratio.value     = this.compressorRatio;
    this.compressor.attack.value    = 0.003;
    this.compressor.release.value   = 0.25;

    // ── Gain nodes — allow 4× boost for louder audio ──
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = this.volume;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1.0;

    // ── Output limiter ───────────────────────────────────
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.0;
    this.limiter.knee.value      = 0.0;
    this.limiter.ratio.value     = 20.0;
    this.limiter.attack.value    = 0.001;
    this.limiter.release.value   = 0.08;

    // ── Recording destination ────────────────────────────
    this.recordDest = this.ctx.createMediaStreamDestination();

    // ── Signal chain ─────────────────────────────────────
    // source → bass → mid → treble → presence → air → compressor → gain → masterGain → limiter → analyser → destination
    this.bassFilter.connect(this.midFilter);
    this.midFilter.connect(this.trebleFilter);
    this.trebleFilter.connect(this.presenceFilter);
    this.presenceFilter.connect(this.airFilter);
    this.airFilter.connect(this.compressor);
    this.compressor.connect(this.gainNode);
    this.gainNode.connect(this.masterGain);
    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    // Compressor starts bypassed (ratio=1 = no compression)
    this.compressor.ratio.value = 1;

    // Record destination taps after master gain
    this.masterGain.connect(this.recordDest);

    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
  }

  _connectSource(node) {
    node.connect(this.bassFilter);
  }

  _applySourcePlayback(source) {
    source.playbackRate.value = this.playbackSpeed;
    if ('detune' in source) {
      source.detune.value = this.pitchSemitones * 100;
    }
  }

  async loadBuffer(file) {
    await this.init();
    const ab = await file.arrayBuffer();
    return this.ctx.decodeAudioData(ab);
  }

  play(buffer, offset) {
    if (!buffer) return;
    this.stopSource();

    const from = (offset !== undefined && offset !== null) ? offset : this.pausedAt;
    this.pausedAt = Math.max(0, from);
    this.startedAt = this.ctx.currentTime;

    this.source = this.ctx.createBufferSource();
    this.source.buffer = buffer;
    this.source.loop = false;
    this._applySourcePlayback(this.source);
    this._connectSource(this.source);
    this.source.start(0, this.pausedAt);
    this.isPlaying = true;
    this.audioBuffer = buffer;

    this.source.onended = () => {
      if (this.isPlaying) {
        this.isPlaying = false;
        this.pausedAt = 0;
        if (this._onEnded) this._onEnded();
      }
    };
  }

  pause() {
    if (!this.isPlaying || this.isMic) return;
    this.pausedAt = this.getCurrentTime();
    this.stopSource();
    this.isPlaying = false;
  }

  resume(buffer) {
    if (this.isPlaying || this.isMic || !buffer) return;
    this.play(buffer, this.pausedAt);
  }

  restartAt(buffer, time) {
    if (!buffer || this.isMic) return;
    const wasPlaying = this.isPlaying;
    this.pausedAt = Math.max(0, time);
    if (wasPlaying) {
      this.stopSource();
      this.play(buffer, this.pausedAt);
    }
  }

  restartWithCurrentEffects(buffer) {
    if (!buffer || this.isMic) return;
    const t = this.getCurrentTime();
    const wasPlaying = this.isPlaying;
    this.stopSource();
    if (wasPlaying) {
      this.play(buffer, t);
    } else {
      this.pausedAt = t;
      this.isPlaying = false;
    }
  }

  /* Build the full offline EQ + gain chain */
  _buildEffectChain(ctx, inputNode) {
    const bass = ctx.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = 100;
    bass.gain.value = this.bassFilter ? this.bassFilter.gain.value : 0;

    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 800;
    mid.Q.value = 0.8;
    mid.gain.value = this.midFilter ? this.midFilter.gain.value : 0;

    const treble = ctx.createBiquadFilter();
    treble.type = 'peaking';
    treble.frequency.value = 5000;
    treble.Q.value = 0.7;
    treble.gain.value = this.trebleFilter ? this.trebleFilter.gain.value : 0;

    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 3500;
    presence.Q.value = 1.0;
    presence.gain.value = this.presenceFilter ? this.presenceFilter.gain.value : 0;

    const air = ctx.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = 12000;
    air.gain.value = this.airFilter ? this.airFilter.gain.value : 0;

    // Optional compressor
    const comp = ctx.createDynamicsCompressor();
    if (this.compressorEnabled) {
      comp.threshold.value = this.compressorThreshold;
      comp.knee.value      = this.compressorKnee;
      comp.ratio.value     = this.compressorRatio;
      comp.attack.value    = 0.003;
      comp.release.value   = 0.25;
    } else {
      comp.ratio.value = 1; // bypass
    }

    const gain = ctx.createGain();
    gain.gain.value = Math.min(4, this.volume * (this.masterGain ? this.masterGain.gain.value : 1));

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.0;
    limiter.knee.value      = 0.0;
    limiter.ratio.value     = 20.0;
    limiter.attack.value    = 0.001;
    limiter.release.value   = 0.08;

    inputNode.connect(bass);
    bass.connect(mid);
    mid.connect(treble);
    treble.connect(presence);
    presence.connect(air);
    air.connect(comp);
    comp.connect(gain);
    gain.connect(limiter);

    return limiter;
  }

  async renderProcessedAudio(buffer) {
    if (!buffer) return null;
    await this.init();

    const rate = this.playbackSpeed;
    const length = Math.ceil(buffer.sampleRate * (buffer.duration / rate));
    const offline = new OfflineAudioContext(buffer.numberOfChannels, length, buffer.sampleRate);

    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    if ('detune' in source) {
      source.detune.value = this.pitchSemitones * 100;
    }

    const output = this._buildEffectChain(offline, source);
    output.connect(offline.destination);
    source.start(0);

    return offline.startRendering();
  }

  /* WAV encoder with TPDF dithering */
  audioBufferToWav(buffer, normalize = false) {
    let buf = buffer;

    if (normalize) {
      buf = this._normalizeForExport(buffer, 0.944);
    }

    const numChannels = buf.numberOfChannels;
    const sampleRate  = buf.sampleRate;
    const samples     = buf.length;
    const bytesPerSample = 2;
    const blockAlign  = numChannels * bytesPerSample;
    const dataSize    = samples * blockAlign;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view        = new DataView(arrayBuffer);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    // TPDF dithering
    let offset = 44;
    for (let i = 0; i < samples; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const raw = buf.getChannelData(ch)[i];
        const dither = (Math.random() - Math.random()) / 32768;
        const clamped = Math.max(-1, Math.min(1, raw + dither));
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        offset += 2;
      }
    }

    return new Blob([arrayBuffer], { type: 'audio/wav' });
  }

  /* MP3 export via lamejs (loaded from CDN in index.html) */
  audioBufferToMp3(buffer, bitrate = 192) {
    if (typeof lamejs === 'undefined') {
      console.warn('[AudioForge] lamejs not loaded — falling back to WAV');
      return this.audioBufferToWav(buffer, true);
    }

    const numChannels = buffer.numberOfChannels;
    const sampleRate  = buffer.sampleRate;
    const kbps        = bitrate;

    // lamejs expects Int16 PCM
    const left  = buffer.getChannelData(0);
    const right  = numChannels > 1 ? buffer.getChannelData(1) : left;

    const mp3enc = new lamejs.Mp3Encoder(numChannels > 1 ? 2 : 1, sampleRate, kbps);
    const blockSize = 1152;
    const mp3Data   = [];

    const toInt16 = (f32) => {
      const out = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out;
    };

    const leftInt  = toInt16(left);
    const rightInt = toInt16(right);

    for (let i = 0; i < leftInt.length; i += blockSize) {
      const lChunk = leftInt.subarray(i, i + blockSize);
      const rChunk = rightInt.subarray(i, i + blockSize);
      let mp3buf;
      if (numChannels > 1) {
        mp3buf = mp3enc.encodeBuffer(lChunk, rChunk);
      } else {
        mp3buf = mp3enc.encodeBuffer(lChunk);
      }
      if (mp3buf.length > 0) mp3Data.push(mp3buf);
    }

    const end = mp3enc.flush();
    if (end.length > 0) mp3Data.push(end);

    return new Blob(mp3Data, { type: 'audio/mp3' });
  }

  _normalizeForExport(buffer, targetPeak = 0.944) {
    let maxAmp = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const abs = Math.abs(data[i]);
        if (abs > maxAmp) maxAmp = abs;
      }
    }
    if (maxAmp < 0.001) return buffer;

    const scale  = targetPeak / maxAmp;
    const result = new AudioBuffer({
      numberOfChannels: buffer.numberOfChannels,
      length:           buffer.length,
      sampleRate:       buffer.sampleRate
    });
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch);
      const dst = result.getChannelData(ch);
      for (let i = 0; i < src.length; i++) dst[i] = src[i] * scale;
    }
    return result;
  }

  async exportProcessedWav(buffer, normalize = true) {
    const rendered = await this.renderProcessedAudio(buffer);
    return rendered ? this.audioBufferToWav(rendered, normalize) : null;
  }

  stopSource() {
    try {
      if (this.source) {
        this.source.onended = null;
        this.source.stop();
        this.source.disconnect();
        this.source = null;
      }
    } catch (_) {}
  }

  stopAll() {
    this.stopSource();
    this.stopMicStream();
    this.isPlaying = false;
    this.isMic = false;
    this.pausedAt = 0;
  }

  async startMic() {
    await this.init();
    this.stopAll();
    this.isMic = true;

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation:   false,
          noiseSuppression:   false,
          autoGainControl:    false,
          sampleRate:         48000,
          channelCount:       1,
          latency:            0
        }
      });

      const micSource = this.ctx.createMediaStreamSource(this.micStream);

      // Pre-amp: boost mic signal ×6 (≈ +15.6 dB) before EQ chain
      this.micPreAmp = this.ctx.createGain();
      this.micPreAmp.gain.value = 6.0;

      micSource.connect(this.micPreAmp);
      this.micPreAmp.connect(this.bassFilter);
      this.micSource = micSource;
      this.isPlaying = true;
      return true;
    } catch (err) {
      console.warn('Microphone denied:', err);
      this.isMic = false;
      this.isPlaying = false;
      return false;
    }
  }

  stopMicStream() {
    try {
      if (this.micPreAmp) { this.micPreAmp.disconnect(); this.micPreAmp = null; }
      if (this.micSource) { this.micSource.disconnect(); this.micSource = null; }
      if (this.micStream) { this.micStream.getTracks().forEach(t => t.stop()); this.micStream = null; }
    } catch (_) {}
    this.isMic = false;
  }

  getRecordingStream() {
    return this.recordDest ? this.recordDest.stream : this.micStream;
  }

  startRecording() {
    const stream = this.getRecordingStream();
    if (!stream) return false;

    this.recordedChunks = [];

    const mimeTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4'
    ];
    let options = { audioBitsPerSecond: 320000 }; // 320 kbps
    for (const mimeType of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        options = { mimeType, audioBitsPerSecond: 320000 };
        break;
      }
    }

    try {
      this.mediaRecorder = new MediaRecorder(stream, options);
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
      };
      this.mediaRecorder.start(100);
      this.isRecording = true;
      return true;
    } catch (err) {
      console.error('Failed to start MediaRecorder:', err);
      return false;
    }
  }

  stopRecording() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        this.isRecording = false;
        resolve(null);
        return;
      }

      this.mediaRecorder.onstop = () => {
        this.isRecording = false;
        const mimeType = this.mediaRecorder.mimeType || 'audio/webm';
        resolve(new Blob(this.recordedChunks, { type: mimeType }));
      };

      this.mediaRecorder.stop();
    });
  }

  /* ── Volume & EQ setters ──────────────────────── */

  setVolume(v) {
    // Allow up to 400% (gain 4.0) for maximum loudness
    this.volume = Math.max(0, Math.min(4, v));
    if (this.gainNode) {
      this.gainNode.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.015);
    }
  }

  setMasterBoost(pct) {
    const g = Math.max(0, Math.min(4, pct / 100));
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.015);
    }
  }

  setPitch(semitones) {
    this.pitchSemitones = Math.max(-24, Math.min(24, semitones));
    if (this.source && 'detune' in this.source) {
      this.source.detune.setTargetAtTime(this.pitchSemitones * 100, this.ctx.currentTime, 0.01);
    }
  }

  setPlaybackSpeed(rate) {
    this.playbackSpeed = Math.max(0.25, Math.min(4, rate));
    if (this.source && this.source.playbackRate) {
      this.source.playbackRate.setTargetAtTime(this.playbackSpeed, this.ctx.currentTime, 0.01);
    }
  }

  refreshPitchAndSpeed(buffer) {
    if (!buffer || this.isMic) return false;
    if (this.isPlaying) {
      this.restartWithCurrentEffects(buffer);
      return true;
    }
    return false;
  }

  setFFTSize(size) {
    this.FFT_SIZE = size;
    if (this.analyser) {
      this.analyser.fftSize = size;
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    }
  }

  setMinDecibels(db) {
    if (this.analyser) this.analyser.minDecibels = db;
  }

  setBass(db) {
    this.bass = db;
    if (this.bassFilter) this.bassFilter.gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }

  setMid(db) {
    this.mid = db;
    if (this.midFilter) this.midFilter.gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }

  setTreble(db) {
    this.treble = db;
    if (this.trebleFilter) this.trebleFilter.gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }

  setPresence(db) {
    this.presence = db;
    if (this.presenceFilter) this.presenceFilter.gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }

  setAir(db) {
    this.air = db;
    if (this.airFilter) this.airFilter.gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }

  /* Toggle the voice compressor on/off */
  setCompressor(enabled, { ratio = 4, threshold = -24, knee = 6 } = {}) {
    this.compressorEnabled   = enabled;
    this.compressorRatio     = ratio;
    this.compressorThreshold = threshold;
    this.compressorKnee      = knee;
    if (this.compressor && this.ctx) {
      const t = this.ctx.currentTime;
      this.compressor.ratio.setTargetAtTime(enabled ? ratio : 1, t, 0.02);
      this.compressor.threshold.setTargetAtTime(enabled ? threshold : -100, t, 0.02);
      this.compressor.knee.setTargetAtTime(knee, t, 0.02);
    }
  }

  applySettings(settings = {}) {
    if (settings.volume   !== undefined) this.setVolume(settings.volume / 100);
    if (settings.bass     !== undefined) this.setBass(settings.bass);
    if (settings.mid      !== undefined) this.setMid(settings.mid);
    if (settings.treble   !== undefined) this.setTreble(settings.treble);
    if (settings.presence !== undefined) this.setPresence(settings.presence);
    if (settings.air      !== undefined) this.setAir(settings.air);
    if (settings.pitch    !== undefined) this.setPitch(settings.pitch);
    if (settings.speed    !== undefined) this.setPlaybackSpeed(settings.speed);
  }

  getSettings() {
    return {
      bass:     this.bassFilter     ? this.bassFilter.gain.value     : 0,
      mid:      this.midFilter      ? this.midFilter.gain.value      : 0,
      treble:   this.trebleFilter   ? this.trebleFilter.gain.value   : 0,
      presence: this.presenceFilter ? this.presenceFilter.gain.value : 0,
      air:      this.airFilter      ? this.airFilter.gain.value      : 0,
      pitch:    this.pitchSemitones,
      speed:    this.playbackSpeed,
      volume:   Math.round(this.volume * 100)
    };
  }

  getCurrentTime() {
    if (!this.ctx) return 0;
    if (this.isMic) return 0;
    if (!this.isPlaying) return this.pausedAt;
    return this.pausedAt + (this.ctx.currentTime - this.startedAt) * this.playbackSpeed;
  }

  analyse() {
    if (!this.analyser || !this.freqData) return { bass: 0, mid: 0, treble: 0 };

    this.analyser.getByteFrequencyData(this.freqData);

    const bufLen  = this.freqData.length;
    const nyquist = this.ctx ? this.ctx.sampleRate / 2 : 22050;
    const binHz   = nyquist / bufLen;

    const bassEnd   = Math.floor(250 / binHz);
    const midEnd    = Math.floor(4000 / binHz);
    const trebleEnd = Math.floor(16000 / binHz);

    const avg = (a, b) => {
      let s = 0, c = 0;
      for (let i = a; i < Math.min(b, bufLen); i++) { s += this.freqData[i]; c++; }
      return c ? s / c / 255 : 0;
    };

    const k = 0.2;
    this.bass   += (avg(0, bassEnd)           - this.bass)   * k;
    this.mid    += (avg(bassEnd, midEnd)       - this.mid)    * k;
    this.treble += (avg(midEnd, trebleEnd)     - this.treble) * k;

    return { bass: this.bass, mid: this.mid, treble: this.treble };
  }

  getBarData(n = 64) {
    if (!this.freqData) return new Array(n).fill(0);
    const step = Math.floor(this.freqData.length * 0.75 / n);
    return Array.from({ length: n }, (_, i) => this.freqData[Math.min(i * step, this.freqData.length - 1)] / 255);
  }

  /* ─── TRIM ─────────────────────────────────────────── */
  trimBuffer(buffer, startSec, endSec) {
    if (!buffer) return null;
    const rate      = buffer.sampleRate;
    const startSamp = Math.max(0, Math.floor(startSec * rate));
    const endSamp   = Math.min(buffer.length, Math.floor(endSec * rate));
    const length    = endSamp - startSamp;
    if (length <= 0) return null;

    const result = new AudioBuffer({
      numberOfChannels: buffer.numberOfChannels,
      length,
      sampleRate: rate
    });

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch);
      const dst = result.getChannelData(ch);
      dst.set(src.subarray(startSamp, endSamp));
    }
    return result;
  }

  /* ─── MERGE ─────────────────────────────────────────── */
  mergeBuffers(buffers, mode = 'sequential') {
    if (!buffers || !buffers.length) return null;

    const rate     = buffers[0].sampleRate;
    const channels = Math.max(...buffers.map(b => b.numberOfChannels));

    if (mode === 'sequential') {
      const totalLen = buffers.reduce((s, b) => s + b.length, 0);
      const result   = new AudioBuffer({ numberOfChannels: channels, length: totalLen, sampleRate: rate });

      for (let ch = 0; ch < channels; ch++) {
        const dst = result.getChannelData(ch);
        let offset = 0;
        for (const buf of buffers) {
          const srcCh = Math.min(ch, buf.numberOfChannels - 1);
          dst.set(buf.getChannelData(srcCh), offset);
          offset += buf.length;
        }
      }
      return result;
    }

    if (mode === 'overlay') {
      const maxLen = Math.max(...buffers.map(b => b.length));
      const result = new AudioBuffer({ numberOfChannels: channels, length: maxLen, sampleRate: rate });

      for (let ch = 0; ch < channels; ch++) {
        const dst = result.getChannelData(ch);
        for (const buf of buffers) {
          const srcCh = Math.min(ch, buf.numberOfChannels - 1);
          const src   = buf.getChannelData(srcCh);
          for (let i = 0; i < src.length; i++) {
            dst[i] = (dst[i] || 0) + src[i];
          }
        }
        for (let i = 0; i < maxLen; i++) {
          dst[i] = this._softClip(dst[i]);
        }
      }
      return result;
    }

    return null;
  }

  /* ─── MIX TWO BUFFERS WITH SEPARATE GAINS ─────────── */
  mixBuffers(bufferA, bufferB, gainA = 1.0, gainB = 0.5) {
    if (!bufferA && !bufferB) return null;
    if (!bufferA) return bufferB;
    if (!bufferB) return bufferA;

    const rate     = bufferA.sampleRate;
    const channels = Math.max(bufferA.numberOfChannels, bufferB.numberOfChannels);
    const maxLen   = Math.max(bufferA.length, bufferB.length);

    const result = new AudioBuffer({ numberOfChannels: channels, length: maxLen, sampleRate: rate });

    for (let ch = 0; ch < channels; ch++) {
      const dst  = result.getChannelData(ch);
      const chA  = Math.min(ch, bufferA.numberOfChannels - 1);
      const chB  = Math.min(ch, bufferB.numberOfChannels - 1);
      const srcA = bufferA.getChannelData(chA);
      const srcB = bufferB.getChannelData(chB);

      for (let i = 0; i < maxLen; i++) {
        const a = i < srcA.length ? srcA[i] * gainA : 0;
        const b = i < srcB.length ? srcB[i] * gainB : 0;
        dst[i] = this._softClip(a + b);
      }
    }
    return result;
  }

  _softClip(x) {
    if (x >= 1)  return  0.9999;
    if (x <= -1) return -0.9999;
    return x - (x * x * x) / 3;
  }

  exportAs(buffer, format = 'wav') {
    return Promise.resolve(this.audioBufferToWav(buffer, true));
  }
}
