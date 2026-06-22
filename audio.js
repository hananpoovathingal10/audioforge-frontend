/* =====================================================
   NEBULA — Web Audio Engine with EQ + Pitch + Speed
   ===================================================== */

class AudioEngine {
  constructor() {
    this.ctx          = null;
    this.analyser     = null;
    this.source       = null;
    this.gainNode     = null;
    this.bassFilter   = null;
    this.midFilter    = null;
    this.trebleFilter = null;
    this.freqData     = null;
    this.audioBuffer  = null;
    this.micStream    = null;
    this.micSource    = null;
    this.recordDest   = null;

    this.isPlaying = false;
    this.isMic     = false;
    this.startedAt = 0;
    this.pausedAt  = 0;
    this.duration  = 0;
    this.volume    = 0.85;

    this.pitchSemitones = 0;
    this.playbackSpeed  = 1;

    this.bass   = 0;
    this.mid    = 0;
    this.treble = 0;

    this.FFT_SIZE = 2048;
    this._onEnded = null;

    this.isRecording   = false;
    this.mediaRecorder = null;
    this.recordedChunks = [];
  }

  async init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.76;

    this.bassFilter = this.ctx.createBiquadFilter();
    this.bassFilter.type = 'lowshelf';
    this.bassFilter.frequency.value = 250;
    this.bassFilter.gain.value = 0;

    this.midFilter = this.ctx.createBiquadFilter();
    this.midFilter.type = 'peaking';
    this.midFilter.frequency.value = 1200;
    this.midFilter.Q.value = 0.8;
    this.midFilter.gain.value = 0;

    this.trebleFilter = this.ctx.createBiquadFilter();
    this.trebleFilter.type = 'highshelf';
    this.trebleFilter.frequency.value = 4000;
    this.trebleFilter.gain.value = 0;

    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = this.volume;

    this.recordDest = this.ctx.createMediaStreamDestination();

    this.bassFilter.connect(this.midFilter);
    this.midFilter.connect(this.trebleFilter);
    this.trebleFilter.connect(this.gainNode);
    this.gainNode.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.gainNode.connect(this.recordDest);

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

  _buildEffectChain(ctx, inputNode) {
    const bass = ctx.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = 250;
    bass.gain.value = this.bassFilter ? this.bassFilter.gain.value : 0;

    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1200;
    mid.Q.value = 0.8;
    mid.gain.value = this.midFilter ? this.midFilter.gain.value : 0;

    const treble = ctx.createBiquadFilter();
    treble.type = 'highshelf';
    treble.frequency.value = 4000;
    treble.gain.value = this.trebleFilter ? this.trebleFilter.gain.value : 0;

    const gain = ctx.createGain();
    gain.gain.value = this.volume;

    inputNode.connect(bass);
    bass.connect(mid);
    mid.connect(treble);
    treble.connect(gain);

    return gain;
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

  audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const samples = buffer.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = samples * blockAlign;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);

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

    let offset = 44;
    for (let i = 0; i < samples; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }

    return new Blob([arrayBuffer], { type: 'audio/wav' });
  }

  async exportProcessedWav(buffer) {
    const rendered = await this.renderProcessedAudio(buffer);
    return rendered ? this.audioBufferToWav(rendered) : null;
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
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      const micSource = this.ctx.createMediaStreamSource(this.micStream);
      this._connectSource(micSource);
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

    const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'];
    let options = {};
    for (const mimeType of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        options = { mimeType };
        break;
      }
    }

    try {
      this.mediaRecorder = new MediaRecorder(stream, options);
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
      };
      this.mediaRecorder.start(250);
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

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gainNode) {
      this.gainNode.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.015);
    }
  }

  setPitch(semitones) {
    this.pitchSemitones = Math.max(-12, Math.min(12, semitones));
    if (this.source && 'detune' in this.source) {
      this.source.detune.setTargetAtTime(this.pitchSemitones * 100, this.ctx.currentTime, 0.01);
    }
  }

  setPlaybackSpeed(rate) {
    this.playbackSpeed = Math.max(0.5, Math.min(2, rate));
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
    if (this.bassFilter) this.bassFilter.gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }

  setMid(db) {
    if (this.midFilter) this.midFilter.gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }

  setTreble(db) {
    if (this.trebleFilter) this.trebleFilter.gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }

  applySettings(settings = {}) {
    if (settings.volume !== undefined) this.setVolume(settings.volume / 100);
    if (settings.bass !== undefined) this.setBass(settings.bass);
    if (settings.mid !== undefined) this.setMid(settings.mid);
    if (settings.treble !== undefined) this.setTreble(settings.treble);
    if (settings.pitch !== undefined) this.setPitch(settings.pitch);
    if (settings.speed !== undefined) this.setPlaybackSpeed(settings.speed);
  }

  getSettings() {
    return {
      bass: this.bassFilter ? this.bassFilter.gain.value : 0,
      mid: this.midFilter ? this.midFilter.gain.value : 0,
      treble: this.trebleFilter ? this.trebleFilter.gain.value : 0,
      pitch: this.pitchSemitones,
      speed: this.playbackSpeed,
      volume: Math.round(this.volume * 100)
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

    const bufLen = this.freqData.length;
    const nyquist = this.ctx ? this.ctx.sampleRate / 2 : 22050;
    const binHz = nyquist / bufLen;

    const bassEnd = Math.floor(250 / binHz);
    const midEnd = Math.floor(4000 / binHz);
    const trebleEnd = Math.floor(16000 / binHz);

    const avg = (a, b) => {
      let s = 0, c = 0;
      for (let i = a; i < Math.min(b, bufLen); i++) { s += this.freqData[i]; c++; }
      return c ? s / c / 255 : 0;
    };

    const k = 0.2;
    this.bass += (avg(0, bassEnd) - this.bass) * k;
    this.mid += (avg(bassEnd, midEnd) - this.mid) * k;
    this.treble += (avg(midEnd, trebleEnd) - this.treble) * k;

    return { bass: this.bass, mid: this.mid, treble: this.treble };
  }

  getBarData(n = 64) {
    if (!this.freqData) return new Array(n).fill(0);
    const step = Math.floor(this.freqData.length * 0.75 / n);
    return Array.from({ length: n }, (_, i) => this.freqData[Math.min(i * step, this.freqData.length - 1)] / 255);
  }

  /* ─── TRIM ────────────────────────────────────────────── */
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

  /* ─── MERGE ───────────────────────────────────────────── */
  mergeBuffers(buffers, mode = 'sequential') {
    if (!buffers || !buffers.length) return null;

    // Normalize all to same sample rate / channels
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
            dst[i] = Math.max(-1, Math.min(1, (dst[i] || 0) + src[i]));
          }
        }
      }
      return result;
    }

    return null;
  }

  /* ─── MIX TWO BUFFERS WITH SEPARATE GAINS ─────────────── */
  mixBuffers(bufferA, bufferB, gainA = 1.0, gainB = 0.5) {
    if (!bufferA && !bufferB) return null;
    if (!bufferA) return bufferB;
    if (!bufferB) return bufferA;

    const rate     = bufferA.sampleRate;
    const channels = Math.max(bufferA.numberOfChannels, bufferB.numberOfChannels);
    const maxLen   = Math.max(bufferA.length, bufferB.length);

    const result = new AudioBuffer({ numberOfChannels: channels, length: maxLen, sampleRate: rate });

    for (let ch = 0; ch < channels; ch++) {
      const dst = result.getChannelData(ch);
      const chA  = Math.min(ch, bufferA.numberOfChannels - 1);
      const chB  = Math.min(ch, bufferB.numberOfChannels - 1);
      const srcA = bufferA.getChannelData(chA);
      const srcB = bufferB.getChannelData(chB);

      for (let i = 0; i < maxLen; i++) {
        const a = i < srcA.length ? srcA[i] * gainA : 0;
        const b = i < srcB.length ? srcB[i] * gainB : 0;
        dst[i] = Math.max(-1, Math.min(1, a + b));
      }
    }
    return result;
  }

  /* ─── EXPORT FORMATS ──────────────────────────────────── */
  audioBufferToOgg(buffer) {
    // OGG export via MediaRecorder (best effort)
    return new Promise((resolve) => {
      const ctx       = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
      const src       = ctx.createBufferSource();
      const dest      = ctx.createMediaStreamDestination ? null : null; // not available in offline
      // Fallback: return WAV if OGG not feasible
      resolve(this.audioBufferToWav(buffer));
    });
  }

  exportAs(buffer, format = 'wav') {
    if (format === 'wav') {
      return Promise.resolve(this.audioBufferToWav(buffer));
    }
    // For MP3/OGG we return WAV as a safe fallback (lamejs not loaded)
    return Promise.resolve(this.audioBufferToWav(buffer));
  }
}
