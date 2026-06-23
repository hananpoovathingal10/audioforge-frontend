/* =====================================================
   AudioForge AI — Effects Engine v2
   Reverb, Echo, Robot Voice, Radio Voice, Noise Gate
   ===================================================== */

class AudioEffects {
  constructor(audioEngine) {
    this.engine = audioEngine;
    this.activeEffects = {
      reverb: false,
      echo: false,
      robot: false,
      radio: false,
      noiseGate: false
    };

    // Effect nodes
    this.reverbNode    = null;
    this.echoDelay     = null;
    this.echoFeedback  = null;
    this.echoGain      = null;
    this.ringMod       = null;
    this.ringOsc       = null;
    this.bandpass      = null;
    this.distortion    = null;
    this.radioFilter   = null;
    this.noiseGateProc = null;

    // Effect parameters
    this.reverbWet   = 0.4;
    this.echoDelaySec = 0.3;
    this.echoFeedbackVal = 0.4;
    this.ringFreq    = 50;
    this.noiseThr    = 0.03;
  }

  _getCtx() {
    return this.engine.ctx;
  }

  /* ── REVERB ─────────────────────────────────────────── */
  generateImpulse(duration = 2.0, decay = 2.0) {
    const ctx = this._getCtx();
    if (!ctx) return null;
    const rate   = ctx.sampleRate;
    const length = Math.floor(rate * duration);
    const ir     = ctx.createBuffer(2, length, rate);

    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return ir;
  }

  applyReverb(type = 'room') {
    const ctx = this._getCtx();
    if (!ctx) return;
    const configs = {
      room:      { duration: 1.2, decay: 2.5 },
      hall:      { duration: 3.0, decay: 2.0 },
      cathedral: { duration: 5.0, decay: 1.5 }
    };
    const cfg = configs[type] || configs.room;
    const ir  = this.generateImpulse(cfg.duration, cfg.decay);

    if (this.reverbNode) {
      try { this.reverbNode.disconnect(); } catch(_) {}
    }
    this.reverbNode = ctx.createConvolver();
    this.reverbNode.buffer = ir;
    this.activeEffects.reverb = true;
  }

  removeReverb() {
    if (this.reverbNode) {
      try { this.reverbNode.disconnect(); } catch(_) {}
      this.reverbNode = null;
    }
    this.activeEffects.reverb = false;
  }

  /* ── ECHO ────────────────────────────────────────────── */
  applyEcho(delayTime = 0.3, feedback = 0.4) {
    const ctx = this._getCtx();
    if (!ctx) return;

    if (this.echoDelay) {
      try { this.echoDelay.disconnect(); } catch(_) {}
      try { this.echoFeedback.disconnect(); } catch(_) {}
      try { this.echoGain.disconnect(); } catch(_) {}
    }

    this.echoDelay    = ctx.createDelay(5.0);
    this.echoFeedback = ctx.createGain();
    this.echoGain     = ctx.createGain();

    this.echoDelay.delayTime.value   = delayTime;
    this.echoFeedback.gain.value     = feedback;
    this.echoGain.gain.value         = 0.6;

    this.echoDelaySec       = delayTime;
    this.echoFeedbackVal    = feedback;
    this.activeEffects.echo = true;
  }

  removeEcho() {
    [this.echoDelay, this.echoFeedback, this.echoGain].forEach(n => {
      if (n) try { n.disconnect(); } catch(_) {}
    });
    this.echoDelay = this.echoFeedback = this.echoGain = null;
    this.activeEffects.echo = false;
  }

  /* ── ROBOT VOICE (Ring Modulation) ─────────────────── */
  applyRobotVoice(freq = 50) {
    const ctx = this._getCtx();
    if (!ctx) return;

    if (this.ringOsc) {
      try { this.ringOsc.stop(); this.ringOsc.disconnect(); } catch(_) {}
      try { this.ringMod.disconnect(); } catch(_) {}
    }

    this.ringOsc = ctx.createOscillator();
    this.ringMod = ctx.createGain();

    this.ringOsc.type            = 'square';
    this.ringOsc.frequency.value = freq;
    this.ringMod.gain.value      = 0;

    this.ringOsc.connect(this.ringMod.gain);
    this.ringOsc.start();

    this.ringFreq             = freq;
    this.activeEffects.robot  = true;
  }

  removeRobotVoice() {
    if (this.ringOsc) {
      try { this.ringOsc.stop(); this.ringOsc.disconnect(); } catch(_) {}
      try { this.ringMod.disconnect(); } catch(_) {}
      this.ringOsc = this.ringMod = null;
    }
    this.activeEffects.robot = false;
  }

  /* ── RADIO VOICE ─────────────────────────────────────── */
  applyRadioVoice() {
    const ctx = this._getCtx();
    if (!ctx) return;

    if (this.bandpass) {
      try { this.bandpass.disconnect(); } catch(_) {}
      try { this.distortion.disconnect(); } catch(_) {}
      try { this.radioFilter.disconnect(); } catch(_) {}
    }

    // Narrow bandpass (1kHz – 4kHz) to simulate AM radio
    this.bandpass = ctx.createBiquadFilter();
    this.bandpass.type            = 'bandpass';
    this.bandpass.frequency.value = 2000;
    this.bandpass.Q.value         = 0.8;

    // Waveshaper for distortion
    this.distortion = ctx.createWaveShaper();
    this.distortion.curve   = this._makeDistortionCurve(200);
    this.distortion.oversample = '2x';

    // High-pass to cut rumble
    this.radioFilter = ctx.createBiquadFilter();
    this.radioFilter.type            = 'highpass';
    this.radioFilter.frequency.value = 300;

    this.activeEffects.radio = true;
  }

  _makeDistortionCurve(amount = 50) {
    const n_samples = 256;
    const curve     = new Float32Array(n_samples);
    const deg       = Math.PI / 180;
    for (let i = 0; i < n_samples; i++) {
      const x = (i * 2) / n_samples - 1;
      curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }

  removeRadioVoice() {
    [this.bandpass, this.distortion, this.radioFilter].forEach(n => {
      if (n) try { n.disconnect(); } catch(_) {}
    });
    this.bandpass = this.distortion = this.radioFilter = null;
    this.activeEffects.radio = false;
  }

  /* ── RENDER WITH EFFECTS ─────────────────────────────── */
  async renderWithEffects(sourceBuffer, engine) {
    if (!sourceBuffer) return null;
    await engine.init();

    const rate    = sourceBuffer.sampleRate;
    // Extend buffer to capture reverb/echo tail
    const tailSec = this.activeEffects.reverb ? 5.0 :
                    this.activeEffects.echo    ? this.echoDelaySec * 8 : 0;
    const length  = sourceBuffer.length + Math.ceil(tailSec * rate);
    const offline = new OfflineAudioContext(
      sourceBuffer.numberOfChannels, length, rate
    );

    const src = offline.createBufferSource();
    src.buffer = sourceBuffer;

    let currentNode = src;

    // ── Robot voice ──────────────────────────────────
    if (this.activeEffects.robot) {
      const ringOsc = offline.createOscillator();
      const ringMod = offline.createGain();
      ringOsc.type            = 'square';
      ringOsc.frequency.value = this.ringFreq;
      ringMod.gain.value      = 0;
      ringOsc.connect(ringMod.gain);
      currentNode.connect(ringMod);
      currentNode = ringMod;
      ringOsc.start();
    }

    // ── Radio voice ──────────────────────────────────
    if (this.activeEffects.radio) {
      const bp = offline.createBiquadFilter();
      bp.type            = 'bandpass';
      bp.frequency.value = 2000;
      bp.Q.value         = 1.2;
      const dist = offline.createWaveShaper();
      dist.curve      = this._makeDistortionCurve(150);
      dist.oversample = '4x';
      const hp = offline.createBiquadFilter();
      hp.type            = 'highpass';
      hp.frequency.value = 300;
      // Recover gain lost in bandpass
      const radioGain = offline.createGain();
      radioGain.gain.value = 2.5;
      currentNode.connect(bp);
      bp.connect(dist);
      dist.connect(hp);
      hp.connect(radioGain);
      currentNode = radioGain;
    }

    // ── Reverb (dry/wet parallel) ─────────────────────
    if (this.activeEffects.reverb) {
      const convolver = offline.createConvolver();
      const ir = this._buildOfflineImpulse(offline, 3.0, 2.0);
      convolver.buffer = ir;
      const dryGain = offline.createGain();
      const wetGain = offline.createGain();
      dryGain.gain.value = 1 - this.reverbWet;
      wetGain.gain.value = this.reverbWet * 1.5; // compensate for wet level drop
      currentNode.connect(dryGain);
      currentNode.connect(convolver);
      convolver.connect(wetGain);
      const merger = offline.createGain();
      dryGain.connect(merger);
      wetGain.connect(merger);
      currentNode = merger;
    }

    // ── Echo ─────────────────────────────────────────
    if (this.activeEffects.echo) {
      const delay    = offline.createDelay(5.0);
      const feedback = offline.createGain();
      const wet      = offline.createGain();
      delay.delayTime.value = this.echoDelaySec;
      feedback.gain.value   = this.echoFeedbackVal;
      wet.gain.value        = 0.6;
      currentNode.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(wet);
      const out = offline.createGain();
      currentNode.connect(out);
      wet.connect(out);
      currentNode = out;
    }

    // ── EQ + gain from engine (applied to export) ─────
    const bass = offline.createBiquadFilter();
    bass.type = 'lowshelf'; bass.frequency.value = 120;
    bass.gain.value = engine.bassFilter ? engine.bassFilter.gain.value : 0;

    const mid = offline.createBiquadFilter();
    mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.9;
    mid.gain.value = engine.midFilter ? engine.midFilter.gain.value : 0;

    const treble = offline.createBiquadFilter();
    treble.type = 'peaking'; treble.frequency.value = 5000; treble.Q.value = 0.8;
    treble.gain.value = engine.trebleFilter ? engine.trebleFilter.gain.value : 0;

    const presence = offline.createBiquadFilter();
    presence.type = 'peaking'; presence.frequency.value = 3500; presence.Q.value = 1.2;
    presence.gain.value = engine.presenceFilter ? engine.presenceFilter.gain.value : 0;

    const air = offline.createBiquadFilter();
    air.type = 'highshelf'; air.frequency.value = 10000;
    air.gain.value = engine.airFilter ? engine.airFilter.gain.value : 0;

    const masterGain = offline.createGain();
    masterGain.gain.value = Math.min(2, engine.volume * (engine.masterGain ? engine.masterGain.gain.value : 1));

    // Limiter on output
    // Limiter with Soft-Clipping
    const limiter = offline.createDynamicsCompressor();
    limiter.threshold.value = -1.0;
    limiter.knee.value      = 6.0;
    limiter.ratio.value     = 20.0;
    limiter.attack.value    = 0.001;
    limiter.release.value   = 0.1;

    currentNode.connect(bass);
    bass.connect(mid);
    mid.connect(treble);
    treble.connect(presence);
    presence.connect(air);
    air.connect(masterGain);
    masterGain.connect(limiter);
    limiter.connect(offline.destination);
    src.start(0);

    return offline.startRendering();
  }

  _buildOfflineImpulse(ctx, duration, decay) {
    const rate   = ctx.sampleRate;
    const length = Math.floor(rate * duration);
    const ir     = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return ir;
  }

  /* ── NOISE REDUCTION (Envelope follower gate) ───────── */
  async applyNoiseReduction(buffer, threshold = 0.03) {
    if (!buffer) return null;

    const rate = buffer.sampleRate;

    // Step 1: HP filter + compressor via OfflineAudioContext
    const offline = new OfflineAudioContext(
      buffer.numberOfChannels, buffer.length, rate
    );
    const src = offline.createBufferSource();
    src.buffer = buffer;

    const hp = offline.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 80; hp.Q.value = 0.7;

    const comp = offline.createDynamicsCompressor();
    comp.threshold.value = -40;
    comp.knee.value      = 6;
    comp.ratio.value     = 8;
    comp.attack.value    = 0.005;
    comp.release.value   = 0.2;

    src.connect(hp);
    hp.connect(comp);
    comp.connect(offline.destination);
    src.start(0);

    const rendered = await offline.startRendering();

    // Step 2: envelope-follower gate (smooth, not hard)
    const result = new AudioBuffer({
      numberOfChannels: rendered.numberOfChannels,
      length:           rendered.length,
      sampleRate:       rate
    });

    const attackSamples  = Math.floor(0.010 * rate); // 10ms attack
    const releaseSamples = Math.floor(0.080 * rate); // 80ms release

    for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
      const input  = rendered.getChannelData(ch);
      const output = result.getChannelData(ch);
      let envelope = 0;
      for (let i = 0; i < input.length; i++) {
        const abs = Math.abs(input[i]);
        if (abs > envelope) {
          envelope += (abs - envelope) / Math.max(1, attackSamples);
        } else {
          envelope += (abs - envelope) / Math.max(1, releaseSamples);
        }
        const gateGain = envelope > threshold ? 1.0 : Math.max(0, envelope / threshold);
        output[i] = input[i] * gateGain;
      }
    }

    return result;
  }

  /* ── SILENCE REMOVAL ─────────────────────────────────── */
  removeSilence(buffer, threshold = 0.01, minSilenceDur = 0.3) {
    if (!buffer) return null;
    const rate   = buffer.sampleRate;
    const ch0    = buffer.getChannelData(0);
    const minLen = Math.floor(minSilenceDur * rate);
    const chunks = []; // { start, end } of non-silent audio regions

    let regionStart = null;
    let silenceStart = null;

    for (let i = 0; i < ch0.length; i++) {
      const silent = Math.abs(ch0[i]) < threshold;

      if (!silent) {
        // We're in audio
        if (regionStart === null) regionStart = i;
        silenceStart = null;
      } else {
        // We're in silence
        if (silenceStart === null) silenceStart = i;
        // If silence is long enough, end the current region
        if (regionStart !== null && (i - silenceStart) >= minLen) {
          chunks.push({ start: regionStart, end: silenceStart });
          regionStart  = null;
          silenceStart = null;
        }
      }
    }
    // Don't forget the last region
    if (regionStart !== null) {
      chunks.push({ start: regionStart, end: ch0.length });
    }

    if (!chunks.length) return buffer;

    const totalLen = chunks.reduce((s, c) => s + (c.end - c.start), 0);
    if (totalLen < 1) return buffer;

    const result = new AudioBuffer({
      numberOfChannels: buffer.numberOfChannels,
      length:           totalLen,
      sampleRate:       rate
    });

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch);
      const dst = result.getChannelData(ch);
      let offset = 0;
      for (const chunk of chunks) {
        const slice = src.subarray(chunk.start, chunk.end);
        dst.set(slice, offset);
        offset += slice.length;
      }
    }

    return result;
  }

  /* ── FADE IN / FADE OUT ──────────────────────────────── */
  async applyFade(buffer, fadeInSec = 0.5, fadeOutSec = 0.5) {
    if (!buffer) return null;
    const rate       = buffer.sampleRate;
    const fadeInLen  = Math.min(Math.floor(fadeInSec * rate), buffer.length / 2);
    const fadeOutLen = Math.min(Math.floor(fadeOutSec * rate), buffer.length / 2);

    // Work on a copy
    const result = new AudioBuffer({
      numberOfChannels: buffer.numberOfChannels,
      length:           buffer.length,
      sampleRate:       rate
    });

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch);
      const dst = result.getChannelData(ch);
      dst.set(src);

      // Fade in
      for (let i = 0; i < fadeInLen; i++) {
        dst[i] *= i / fadeInLen;
      }
      // Fade out
      for (let i = 0; i < fadeOutLen; i++) {
        dst[buffer.length - 1 - i] *= i / fadeOutLen;
      }
    }

    return result;
  }

  /* ── PITCH SHIFT (Resample trick) ───────────────────── */
  async shiftPitch(buffer, semitones) {
    if (!buffer || semitones === 0) return buffer;
    const rate        = buffer.sampleRate;
    const ratio       = Math.pow(2, semitones / 12);
    const newLength   = Math.floor(buffer.length / ratio);

    const offline = new OfflineAudioContext(
      buffer.numberOfChannels,
      newLength,
      rate
    );

    const src = offline.createBufferSource();
    src.buffer            = buffer;
    src.playbackRate.value = ratio;
    if ('detune' in src) src.detune.value = semitones * 100;
    src.connect(offline.destination);
    src.start(0);

    return offline.startRendering();
  }

  /* ── NORMALIZE ───────────────────────────────────────── */
  normalizeBuffer(buffer, targetPeak = 0.95) {
    if (!buffer) return null;
    let maxAmp = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        maxAmp = Math.max(maxAmp, Math.abs(data[i]));
      }
    }
    if (maxAmp === 0) return buffer;

    const scale = targetPeak / maxAmp;
    const result = new AudioBuffer({
      numberOfChannels: buffer.numberOfChannels,
      length:           buffer.length,
      sampleRate:       buffer.sampleRate
    });

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch);
      const dst = result.getChannelData(ch);
      for (let i = 0; i < src.length; i++) {
        dst[i] = src[i] * scale;
      }
    }
    return result;
  }
}
