/* =====================================================
   AudioForge AI — Main App v4
   Full feature set: Trim, Merge, Mix, Effects, Transcript, TTS
   ===================================================== */

(function () {
  'use strict';

  // Mock getUserMedia for testing if ?mockMic=true is in the URL
  if (window.location.search.includes('mockMic=true')) {
    if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
      const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async function(constraints) {
        try { return await origGetUserMedia(constraints); } catch (e) {
          const mockCtx = new (window.AudioContext || window.webkitAudioContext)();
          const osc = mockCtx.createOscillator(); const dest = mockCtx.createMediaStreamDestination();
          osc.type = 'sine'; osc.frequency.value = 440; osc.connect(dest); osc.start(); return dest.stream;
        }
      };
    }
  }

  /* ════════════════════════════════════════════════════
     1. THREE.JS BACKGROUND
  ════════════════════════════════════════════════════ */
  let renderer = null, scene = null, camera = null, uniforms = null;
  let nebulaSpeed = 1.0, nebulaTheme = 0.0, shaderTime = 0, lastTime = 0;

  try {
    const nebulaCanvas = document.getElementById('nebula-canvas');
    renderer = new THREE.WebGLRenderer({ canvas: nebulaCanvas, antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (THREE.LinearSRGBColorSpace !== undefined)
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    scene  = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.set(0, 0, 1);
    uniforms = {
      uTime:       { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 },
      uTreble:     { value: 0 }, uTheme: { value: 0.0 },
      uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) }
    };
    const geo   = new THREE.BufferGeometry();
    const verts = new Float32Array([-1,-1,0, 1,-1,0, 1,1,0, -1,-1,0, 1,1,0, -1,1,0]);
    const uvs   = new Float32Array([0,0, 1,0, 1,1, 0,0, 1,1, 0,1]);
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setAttribute('uv',       new THREE.BufferAttribute(uvs,   2));
    scene.add(new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: NEBULA_VERTEX_SHADER, fragmentShader: NEBULA_FRAGMENT_SHADER,
      uniforms, depthTest: false, depthWrite: false
    })));
  } catch (e) {
    console.warn('[AudioForge] WebGL init failed:', e);
    const nc = document.getElementById('nebula-canvas');
    if (nc) nc.style.display = 'none';
  }

  /* ════════════════════════════════════════════════════
     2. ENGINES
  ════════════════════════════════════════════════════ */
  const audio    = new AudioEngine();
  const fx       = new AudioEffects(audio);
  const tEngine  = new TranscriptEngine();

  /* ════════════════════════════════════════════════════
     3. STATE
  ════════════════════════════════════════════════════ */
  const tracks    = [];
  let currentIdx  = -1;
  let isPlaying   = false;
  let loopMode    = false;
  let shuffleMode = false;
  let sourceMode  = 'file';

  // Waveform zoom
  let wfZoom       = 1.0;   // 1× = full track, 8× = 8× magnification
  let wfOffset     = 0.0;   // normalised scroll offset [0,1)
  let wfStaticCtx  = null;  // 2D context for the PCM seek canvas
  let wfSeekDragging = false;

  // Trim state
  let trimStartSec = 0;
  let trimEndSec   = 0;
  let trimDragging = null; // 'start' | 'end' | null
  let trimCanvasCtx = null;
  let trimBuffer   = null; // current trimmed buffer

  // Merge state
  let mergeSelectedIdxs = new Set();
  let mergeQueueBuffers = []; // extra files added to merge
  let mergeMode = 'sequential';

  // Mix state
  let mixVoiceBuffer = null;
  let mixMusicBuffer = null;

  const DEFAULT_SETTINGS = { bass: 0, mid: 0, presence: 0, treble: 0, air: 0, pitch: 0, speed: 1, volume: 85 };

  function mergeSettings(settings) {
    return { ...DEFAULT_SETTINGS, ...(settings || {}) };
  }

  function fmt(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;
  }

  /* ════════════════════════════════════════════════════
     4. DOM REFS
  ════════════════════════════════════════════════════ */
  const $  = id => document.getElementById(id);
  const $$ = sel => document.querySelectorAll(sel);

  const els = {
    play:       $('btn-play'),
    playSb:     $('btn-play-sidebar'),
    iconPlay:   $('icon-play'),
    iconPause:  $('icon-pause'),
    spPlay:     $('sp-icon-play'),
    spPause:    $('sp-icon-pause'),
    prev:       $('btn-prev'),
    next:       $('btn-next'),
    loop:       $('btn-loop'),
    shuffle:    $('btn-shuffle'),
    fileIn:     $('file-input'),
    fileIn2:    $('file-input-2'),
    srcFile:    $('src-file'),
    srcMic:     $('src-mic'),
    recDot:     $('rec-dot'),
    trackList:  $('track-list'),
    trackEmpty: $('track-empty'),
    kanban:     $('kanban-board'),
    kanbanEmp:  $('kanban-empty'),
    libCount:   $('lib-count'),
    volSlider:  $('volume-slider'),
    eqVol:      $('eq-volume'),
    eqBass:     $('eq-bass'),
    eqMid:      $('eq-mid'),
    eqPresence: $('eq-presence'),
    eqTreble:   $('eq-treble'),
    eqAir:      $('eq-air'),
    eqPitch:    $('eq-pitch'),
    eqSpeed:    $('eq-speed'),
    eqSmooth:   $('eq-smooth'),
    eqFadeIn:   $('eq-fadein'),
    eqFadeOut:  $('eq-fadeout'),
    eqVolVal:   $('eq-vol-val'),
    eqBassVal:  $('eq-bass-val'),
    eqMidVal:   $('eq-mid-val'),
    eqPresenceVal: $('eq-presence-val'),
    eqTrebVal:  $('eq-treble-val'),
    eqAirVal:   $('eq-air-val'),
    eqPitchVal: $('eq-pitch-val'),
    eqSpeedVal: $('eq-speed-val'),
    eqSmoVal:   $('eq-smooth-val'),
    eqFadeInVal:  $('eq-fadein-val'),
    eqFadeOutVal: $('eq-fadeout-val'),
    eqReset:    $('eq-reset-btn'),
    eqSave:     $('eq-save-btn'),
    eqExport:   $('eq-export-btn'),
    exportFmt:  $('export-format'),
    bpmVal:     $('bpm-val'),
    peakVal:    $('peak-val'),
    durVal:     $('dur-val'),
    volStat:    $('vol-stat'),
    ptName:     $('pt-name'),
    ptMeta:     $('pt-meta'),
    npTitle:    $('np-title'),
    npSub:      $('np-sub'),
    statusDot:  $('status-dot'),
    statusText: $('status-text'),
    fpsEl:      $('fps-display'),
    timeCur:    $('time-cur'),
    timeTotal:  $('time-total'),
    progFill:   $('prog-fill'),
    progThumb:  $('prog-thumb'),
    progTrack:  $('prog-track'),
    dropOver:   $('drop-overlay'),
    curDot:     $('cursor-dot'),
    curRing:    $('cursor-ring'),
    specSub:    $('spec-sub'),
    specMode:   $('spec-mode-btn'),
    specBars:   $('spec-bars-btn'),
    eqCanvas:   $('eq-canvas'),
    specCanvas: $('spectrum-canvas'),
    waveCanvas: $('waveform-canvas'),
    npCanvas:   $('np-canvas'),
    gaugeBass:  $('gauge-bass'),
    gaugeMid:   $('gauge-mid'),
    gaugeTreb:  $('gauge-treble'),
    gvBass:     $('gv-bass'),
    gvMid:      $('gv-mid'),
    gvTreb:     $('gv-treble'),
    fbBass:     $('fb-bass'),
    fbMid:      $('fb-mid'),
    fbTreble:   $('fb-treble'),
    searchIn:   $('search-input'),
    panelViz:   $('panel-visualizer'),
    panelEq:    $('panel-eq'),
    panelTrim:  $('panel-trim'),
    panelMerge: $('panel-merge'),
    panelMix:   $('panel-mix'),
    panelFx:    $('panel-effects'),
    panelTrans: $('panel-transcript'),
    panelLib:   $('panel-library'),
    panelSet:   $('panel-settings'),
    navViz:     $('nav-visualizer'),
    navEq:      $('nav-equalizer'),
    navTrim:    $('nav-trim'),
    navMerge:   $('nav-merge'),
    navMix:     $('nav-mix'),
    navFx:      $('nav-effects'),
    navTrans:   $('nav-transcript'),
    navLib:     $('nav-library'),
    navSet:     $('nav-settings'),
    btnMicRec:  $('btn-mic-record'),
    recPulsar:  $('record-pulsar'),
    recText:    $('record-text'),
  };

  /* ════════════════════════════════════════════════════
     5. CANVAS CONTEXTS
  ════════════════════════════════════════════════════ */
  let sCtx, wCtx, npCtx, eqCtx;

  function resizeCanvases() {
    [{ el: els.specCanvas, ctx: 'sCtx' }, { el: els.waveCanvas, ctx: 'wCtx' }, { el: els.eqCanvas, ctx: 'eqCtx' }].forEach(({ el }) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.width  = (r.width  || 600) * Math.min(window.devicePixelRatio, 2);
      el.height = (r.height || 200) * Math.min(window.devicePixelRatio, 2);
    });
    sCtx  = els.specCanvas?.getContext('2d');
    wCtx  = els.waveCanvas?.getContext('2d');
    eqCtx = els.eqCanvas?.getContext('2d');
    npCtx = els.npCanvas?.getContext('2d');

    // Static waveform / seek canvas
    const wfSc = $('wf-static-canvas');
    if (wfSc) {
      const r = wfSc.getBoundingClientRect();
      wfSc.width  = (r.width  || 800) * Math.min(window.devicePixelRatio, 2);
      wfSc.height = (r.height || 58)  * Math.min(window.devicePixelRatio, 2);
      wfStaticCtx = wfSc.getContext('2d');
      drawStaticWaveform();
    }

    // Trim canvas
    const tc = $('trim-canvas');
    if (tc) {
      const r = tc.getBoundingClientRect();
      tc.width  = (r.width  || 800) * Math.min(window.devicePixelRatio, 2);
      tc.height = (r.height || 120) * Math.min(window.devicePixelRatio, 2);
      trimCanvasCtx = tc.getContext('2d');
    }
    if (trimCanvasCtx) drawTrimWaveform();
  }
  setTimeout(resizeCanvases, 150);
  window.addEventListener('resize', () => {
    if (renderer) renderer.setSize(window.innerWidth, window.innerHeight);
    if (uniforms)  uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
    resizeCanvases();
  });

  /* ════════════════════════════════════════════════════
     6. NAV PANEL SWITCHING
  ════════════════════════════════════════════════════ */
  const allNavs   = [els.navViz, els.navEq, els.navTrim, els.navMerge, els.navMix, els.navFx, els.navTrans, els.navLib, els.navSet];
  const allPanels = [els.panelViz, els.panelEq, els.panelTrim, els.panelMerge, els.panelMix, els.panelFx, els.panelTrans, els.panelLib, els.panelSet];

  function setPanel(name) {
    allNavs.forEach(b => b?.classList.remove('active'));
    allPanels.forEach(p => { if (p) p.style.display = 'none'; });

    const titleEl = $('page-title');
    const subEl   = $('page-sub');

    const configs = {
      visualizer: {
        nav: [els.navViz],
        panels: [els.panelViz, els.panelEq, els.panelLib],
        title: 'Visualizer',
        sub: 'Real-time audio analysis and visualization'
      },
      equalizer: {
        nav: [els.navEq],
        panels: [els.panelEq, els.panelLib],
        title: 'Audio Editor',
        sub: 'EQ · Pitch · Speed · Fade — real-time effects'
      },
      trim: {
        nav: [els.navTrim],
        panels: [els.panelTrim],
        title: '✂ Trim & Cut',
        sub: 'Select a region and trim or export'
      },
      merge: {
        nav: [els.navMerge],
        panels: [els.panelMerge],
        title: '⊕ Merge Audio',
        sub: 'Combine multiple audio files into one'
      },
      mix: {
        nav: [els.navMix],
        panels: [els.panelMix],
        title: '🎛 Voice + Music Mixer',
        sub: 'Layer voice and background music with independent volume control'
      },
      effects: {
        nav: [els.navFx],
        panels: [els.panelFx],
        title: '⚡ Audio Effects',
        sub: 'Reverb · Echo · Robot Voice · Radio · Enhancer'
      },
      transcript: {
        nav: [els.navTrans],
        panels: [els.panelTrans],
        title: '🎤 Transcript & TTS',
        sub: 'Speech-to-Text and Text-to-Speech'
      },
      library: {
        nav: [els.navLib],
        panels: [els.panelLib],
        title: 'Library',
        sub: 'Your audio collection'
      },
      settings: {
        nav: [els.navSet],
        panels: [els.panelSet],
        title: 'Settings',
        sub: 'Application preferences'
      }
    };

    const cfg = configs[name];
    if (!cfg) return;

    cfg.nav.forEach(b => b?.classList.add('active'));
    cfg.panels.forEach(p => { if (p) p.style.display = ''; });
    if (titleEl) titleEl.textContent = cfg.title;
    if (subEl)   subEl.textContent   = cfg.sub;

    if (name === 'trim') {
      setTimeout(() => { resizeCanvases(); drawTrimWaveform(); }, 60);
    }
    if (name === 'merge') renderMergeGrid();
    if (name === 'transcript') populateTTSVoices();
    setTimeout(resizeCanvases, 50);
  }

  els.navViz?.addEventListener('click',   () => setPanel('visualizer'));
  els.navEq?.addEventListener('click',    () => setPanel('equalizer'));
  els.navTrim?.addEventListener('click',  () => setPanel('trim'));
  els.navMerge?.addEventListener('click', () => setPanel('merge'));
  els.navMix?.addEventListener('click',   () => setPanel('mix'));
  els.navFx?.addEventListener('click',    () => setPanel('effects'));
  els.navTrans?.addEventListener('click', () => setPanel('transcript'));
  els.navLib?.addEventListener('click',   () => setPanel('library'));
  els.navSet?.addEventListener('click',   () => setPanel('settings'));

  /* ════════════════════════════════════════════════════
     7. CUSTOM CURSOR
  ════════════════════════════════════════════════════ */
  let cX = 300, cY = 300, rX = 300, rY = 300;
  document.addEventListener('mousemove', e => { cX = e.clientX; cY = e.clientY; });
  document.addEventListener('mousedown', () => document.body.classList.add('clicked'));
  document.addEventListener('mouseup',   () => document.body.classList.remove('clicked'));
  document.addEventListener('mouseover', e => { if (e.target.closest('button,label,input,a,[role="slider"]')) document.body.classList.add('hovered'); });
  document.addEventListener('mouseout',  e => { if (e.target.closest('button,label,input,a,[role="slider"]')) document.body.classList.remove('hovered'); });
  function updateCursor() {
    rX += (cX - rX) * 0.14; rY += (cY - rY) * 0.14;
    if (els.curDot)  { els.curDot.style.left  = cX + 'px'; els.curDot.style.top  = cY + 'px'; }
    if (els.curRing) { els.curRing.style.left = rX + 'px'; els.curRing.style.top = rY + 'px'; }
  }

  /* ════════════════════════════════════════════════════
     8. PLAY STATE UI
  ════════════════════════════════════════════════════ */
  function setPlayUI(playing) {
    isPlaying = playing;
    els.iconPlay.style.display  = playing ? 'none'  : 'block';
    els.iconPause.style.display = playing ? 'block' : 'none';
    els.spPlay.style.display  = playing ? 'none'  : 'block';
    els.spPause.style.display = playing ? 'block' : 'none';
    const color = playing ? 'hsl(155,68%,55%)' : 'hsl(260,70%,60%)';
    els.statusDot.style.background = color;
    els.statusDot.style.boxShadow  = `0 0 7px ${color}`;
    els.statusText.textContent = sourceMode === 'mic' ? 'LIVE REC' : (playing ? 'PLAYING' : 'IDLE');
    $$('.track-kcard').forEach((c, i) => c.classList.toggle('playing-card', playing && i === currentIdx));
    $$('.sidebar-track-item').forEach((c, i) => {
      c.classList.toggle('playing', playing && i === currentIdx);
      const dot = c.querySelector('.sti-playing-dot');
      if (dot) dot.style.display = (playing && i === currentIdx) ? 'block' : 'none';
    });
  }

  /* ════════════════════════════════════════════════════
     9. SOURCE MODE
  ════════════════════════════════════════════════════ */
  function setSourceMode(mode) {
    sourceMode = mode;
    els.srcFile.classList.toggle('src-active', mode === 'file');
    els.srcMic.classList.toggle('src-active',  mode === 'mic');
    els.srcMic.classList.toggle('mic-live',     mode === 'mic' && isPlaying);
    if (els.btnMicRec) {
      els.btnMicRec.style.display = mode === 'mic' ? 'flex' : 'none';
      if (mode !== 'mic') {
        els.recPulsar.style.display = 'none';
        els.recText.textContent = 'Record';
        els.btnMicRec.style.borderColor = 'var(--border)';
      }
    }
  }

  els.srcFile.addEventListener('click', async () => {
    if (sourceMode === 'file') return;
    if (audio.isRecording) await stopRecordingFlow();
    audio.stopMicStream();
    sourceMode = 'file'; setSourceMode('file'); setPlayUI(false);
    els.ptName.textContent = tracks.length ? tracks[Math.max(0,currentIdx)]?.name || 'Select a track' : 'No track loaded';
    els.ptMeta.textContent = 'Click a track in the playlist to play';
  });

  els.srcMic.addEventListener('click', async () => {
    if (sourceMode === 'mic' && audio.isMic) {
      if (audio.isRecording) await stopRecordingFlow();
      audio.stopMicStream(); sourceMode = 'file'; setSourceMode('file'); setPlayUI(false);
      els.ptName.textContent = 'Microphone stopped';
      els.ptMeta.textContent = 'Switch back to file or click mic again'; return;
    }
    sourceMode = 'mic'; setSourceMode('mic'); await audio.init();
    const ok = await audio.startMic();
    if (ok) {
      audio.applySettings({ volume: parseInt(els.eqVol?.value || 85, 10), bass: parseFloat(els.eqBass?.value || 0), mid: parseFloat(els.eqMid?.value || 0), treble: parseFloat(els.eqTreble?.value || 0) });
      setPlayUI(true);
      els.ptName.textContent = '● Live Microphone';
      els.ptMeta.textContent = 'Recording real-time audio input';
      els.npTitle.textContent = 'Live Microphone';
      els.npSub.textContent   = 'Real-time';
      els.specSub.textContent = 'Live microphone — real-time analysis';
    } else {
      sourceMode = 'file'; setSourceMode('file');
      alert('Microphone access denied. Please allow microphone permissions.');
    }
    setSourceMode(sourceMode);
  });

  /* ── Microphone Recording Flow ── */
  let recordStartTime = 0;

  async function startRecordingFlow() {
    if (!audio.isMic) return;
    const ok = audio.startRecording();
    if (ok) {
      recordStartTime = Date.now();
      if (els.recPulsar) els.recPulsar.style.display = 'inline-block';
      if (els.recText) els.recText.textContent = 'Stop & Save';
      if (els.btnMicRec) els.btnMicRec.style.borderColor = 'hsl(0,80%,50%)';
      showToast('🔴 Recording started…');
    } else { showToast('⚠ Failed to start recording'); }
  }

  async function stopRecordingFlow() {
    if (!audio.isRecording) return;
    if (els.recPulsar) els.recPulsar.style.display = 'none';
    if (els.recText) els.recText.textContent = 'Record';
    if (els.btnMicRec) els.btnMicRec.style.borderColor = 'var(--border)';
    const blob = await audio.stopRecording();
    if (!blob) { showToast('⚠ Recording empty or failed'); return; }
    const durationSec = (Date.now() - recordStartTime) / 1000;
    if (durationSec < 1.0) { showToast('⚠ Recording too short'); return; }
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
    const filename = `Recording_${ts}.webm`;
    const recordFile = new File([blob], filename, { type: blob.type });
    showToast('Uploading recording to library…');
    const formData = new FormData();
    formData.append('audio', recordFile);
    try {
      const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
      if (uploadRes.ok) {
        const uploadData = await uploadRes.json();
        const arrayBuffer = await recordFile.arrayBuffer();
        const decodedBuffer = await audio.ctx.decodeAudioData(arrayBuffer.slice(0));
        const newTrack = {
          name: uploadData ? uploadData.name : recordFile.name.replace(/\.[^/.]+$/, ''),
          ext: uploadData ? uploadData.ext : 'WEBM',
          size: recordFile.size,
          filename: uploadData?.filename,
          url: uploadData ? uploadData.url : `/tracks/${encodeURIComponent(recordFile.name)}`,
          buffer: decodedBuffer,
          duration: uploadData?.duration || decodedBuffer.duration,
          settings: mergeSettings(uploadData?.settings)
        };
        tracks.push(newTrack);
        els.libCount.textContent = tracks.length;
        if (els.trackEmpty) els.trackEmpty.style.display = 'none';
        if (els.kanbanEmp)  els.kanbanEmp.style.display  = 'none';
        renderTrackList(); renderKanban();
        showToast('✓ Recording saved to library!');
        await playTrack(tracks.length - 1);
      } else { showToast('⚠ Server upload failed'); }
    } catch (err) { console.error('Failed to save recording:', err); showToast('⚠ Failed to save recording'); }
  }

  els.btnMicRec?.addEventListener('click', async () => {
    if (audio.isRecording) await stopRecordingFlow(); else await startRecordingFlow();
  });

  /* ════════════════════════════════════════════════════
     10. LOAD AUDIO FILES
  ════════════════════════════════════════════════════ */
  async function loadFiles(fileList) {
    const files = Array.from(fileList).filter(f =>
      /^audio\//.test(f.type) || /\.(mp3|wav|flac|ogg|m4a|aac|opus|webm)$/i.test(f.name)
    );
    if (!files.length) { showToast('No supported audio files found'); return; }
    await audio.init();
    showToast(`Loading ${files.length} file${files.length > 1 ? 's' : ''}…`);
    const firstNewIdx = tracks.length;
    for (const file of files) {
      try {
        const ext  = file.name.split('.').pop().toUpperCase();
        const name = file.name.replace(/\.[^/.]+$/, '');
        const ab   = await file.arrayBuffer();
        const buf  = await audio.ctx.decodeAudioData(ab.slice(0));
        const formData = new FormData(); formData.append('audio', file);
        let serverUrl = null, uploadData = null;
        try {
          const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
          if (uploadRes.ok) { uploadData = await uploadRes.json(); serverUrl = uploadData.url; }
        } catch (e) { console.warn('Failed to upload file to backend:', e); }
        tracks.push({ name, ext, duration: uploadData?.duration || buf.duration, size: file.size, buffer: buf, url: serverUrl, filename: uploadData?.filename, settings: mergeSettings(uploadData?.settings) });
        els.libCount.textContent = tracks.length;
        renderTrackList(); renderKanban();
        if (els.trackEmpty) els.trackEmpty.style.display = 'none';
        if (els.kanbanEmp)  els.kanbanEmp.style.display  = 'none';
      } catch (err) { console.error('Failed to decode:', file.name, err); showToast(`⚠ Could not decode: ${file.name}`); }
    }
    showToast(`✓ Loaded ${files.length} track${files.length > 1 ? 's' : ''}`);
    if (sourceMode === 'file' && !isPlaying && tracks.length > 0) await playTrack(firstNewIdx);
  }

  /* ════════════════════════════════════════════════════
     11. PLAY A TRACK
  ════════════════════════════════════════════════════ */
  async function playTrack(idx) {
    if (idx < 0 || idx >= tracks.length) return;
    await audio.init();
    if (audio.isMic) audio.stopMicStream();
    audio.stopSource();
    sourceMode = 'file'; setSourceMode('file');
    currentIdx = idx;
    const t = tracks[idx];
    if (!t.buffer && t.url) {
      showToast(`Streaming ${t.name}…`);
      try {
        const response = await fetch(t.url);
        if (!response.ok) throw new Error('Network error');
        const arrayBuffer = await response.arrayBuffer();
        t.buffer = await audio.ctx.decodeAudioData(arrayBuffer);
        t.duration = t.buffer.duration;
        renderTrackList(); renderKanban();
      } catch (err) { console.error('Failed to stream:', err); showToast('⚠ Failed to download/decode track'); return; }
    }
    audio.pausedAt = 0;
    applyTrackSettings(t);
    audio.play(t.buffer);
    els.ptName.textContent   = t.name;
    els.ptMeta.textContent   = `${t.ext} · ${fmt(t.duration)} · ${(t.size/1e6).toFixed(1)} MB`;
    els.npTitle.textContent  = t.name;
    els.npSub.textContent    = `${t.ext} · ${fmt(t.duration)}`;
    els.durVal.textContent   = fmt(t.duration);
    els.specSub.textContent  = `${t.name} — ${t.ext}`;
    // Init trim state
    trimStartSec = 0;
    trimEndSec   = t.duration;
    updateTrimInputs();

    audio._onEnded = () => {
      setPlayUI(false);
      if (loopMode) { audio.pausedAt = 0; applyTrackSettings(tracks[currentIdx]); audio.play(tracks[currentIdx]?.buffer); setPlayUI(true); }
      else if (shuffleMode && tracks.length > 1) { let n = Math.floor(Math.random()*tracks.length); while(n===currentIdx) n=Math.floor(Math.random()*tracks.length); playTrack(n); }
      else if (currentIdx < tracks.length - 1) playTrack(currentIdx + 1);
    };
    setPlayUI(true);
    drawNpCover(idx);
    drawStaticWaveform();

    // Update transcription track name
    const ttn = $('transcribe-track-name');
    if (ttn) ttn.textContent = `${t.name} (“Transcribe Current Track” to generate transcript)`;
  }

  /* ════════════════════════════════════════════════════
     12. EQ/SETTINGS HELPERS
  ════════════════════════════════════════════════════ */
  function syncEqUI(settings) {
    const s = mergeSettings(settings);
    if (els.eqBass)   els.eqBass.value   = s.bass;
    if (els.eqMid)    els.eqMid.value    = s.mid;
    if (els.eqPresence) els.eqPresence.value = s.presence;
    if (els.eqTreble) els.eqTreble.value = s.treble;
    if (els.eqAir)    els.eqAir.value    = s.air;
    if (els.eqPitch)  els.eqPitch.value  = s.pitch;
    if (els.eqSpeed)  els.eqSpeed.value  = Math.round(s.speed * 100);
    if (els.eqVol)    els.eqVol.value    = s.volume;
    if (els.eqBassVal) els.eqBassVal.textContent   = (s.bass   >= 0 ? '+' : '') + s.bass.toFixed(1)   + ' dB';
    if (els.eqMidVal)  els.eqMidVal.textContent    = (s.mid    >= 0 ? '+' : '') + s.mid.toFixed(1)    + ' dB';
    if (els.eqPresenceVal) els.eqPresenceVal.textContent = (s.presence >= 0 ? '+' : '') + s.presence.toFixed(1) + ' dB';
    if (els.eqTrebVal) els.eqTrebVal.textContent   = (s.treble >= 0 ? '+' : '') + s.treble.toFixed(1) + ' dB';
    if (els.eqAirVal)  els.eqAirVal.textContent    = (s.air    >= 0 ? '+' : '') + s.air.toFixed(1)    + ' dB';
    if (els.eqPitchVal) els.eqPitchVal.textContent = (s.pitch  >= 0 ? '+' : '') + s.pitch.toFixed(1)  + ' st';
    if (els.eqSpeedVal) els.eqSpeedVal.textContent = s.speed.toFixed(2) + '×';
    setVolume(s.volume);
  }

  function applyTrackSettings(track) {
    const s = mergeSettings(track?.settings);
    audio.applySettings(s); syncEqUI(s);
  }

  let settingsSaveTimer;
  function scheduleSaveSettings() {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(saveTrackSettings, 1500);
  }

  async function saveTrackSettings() {
    if (currentIdx < 0) { showToast('Load a track before saving settings'); return; }
    const t = tracks[currentIdx]; const settings = audio.getSettings(); t.settings = settings; syncEqUI(settings);
    if (!t.filename && t.url) t.filename = decodeURIComponent(t.url.split('/').pop());
    if (!t.filename) { showToast('Settings applied locally'); return; }
    try {
      const res = await fetch(`/api/tracks/${encodeURIComponent(t.filename)}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
      showToast(res.ok ? '✓ Settings saved' : '⚠ Could not save settings');
    } catch { showToast('⚠ Could not save settings'); }
  }

  /* ════════════════════════════════════════════════════
     13. RENDER LISTS
  ════════════════════════════════════════════════════ */
  function renderTrackList() {
    els.trackList.querySelectorAll('.sidebar-track-item').forEach(e => e.remove());
    tracks.forEach((t, i) => {
      const el = document.createElement('div');
      el.className = 'sidebar-track-item'; el.dataset.idx = i;
      el.innerHTML = `<span class="sti-num">${(i+1).toString().padStart(2,'0')}</span><div class="sti-info"><div class="sti-name" title="${t.name}">${t.name}</div><div class="sti-dur">${t.duration ? fmt(t.duration) : '--:--'}</div></div><div class="sti-playing-dot" style="display:none"></div>`;
      el.addEventListener('click', () => playTrack(i));
      els.trackList.appendChild(el);
    });
  }

  function renderKanban() {
    els.kanban.querySelectorAll('.track-kcard').forEach(e => e.remove());
    tracks.forEach((t, i) => {
      const card = document.createElement('div');
      card.className = 'track-kcard'; card.dataset.idx = i;
      card.innerHTML = `<div class="kcard-header"><span class="kcard-ext">${t.ext}</span><button class="kcard-delete-btn" aria-label="Delete track">×</button></div><div class="kcard-title" title="${t.name}">${t.name}</div><div class="kcard-footer"><span class="kcard-dur">${t.duration ? fmt(t.duration) : '--:--'}</span><span class="kcard-size">${(t.size/1e6).toFixed(1)} MB</span></div><div class="kcard-play-btn" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>`;
      card.addEventListener('click', () => playTrack(i));
      card.querySelector('.kcard-delete-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Delete ${t.name}?`)) await deleteTrack(i);
      });
      els.kanban.appendChild(card);
    });
  }

  async function deleteTrack(idx) {
    const t = tracks[idx];
    if (t.url) {
      try {
        const filename = t.filename || decodeURIComponent(t.url.split('/').pop());
        await fetch(`/api/tracks/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      } catch(e) { console.warn('Failed to delete from server:', e); }
    }
    tracks.splice(idx, 1);
    els.libCount.textContent = tracks.length;
    if (currentIdx === idx) {
      audio.stopAll(); setPlayUI(false); currentIdx = -1;
      els.ptName.textContent = 'No track loaded'; els.ptMeta.textContent = 'Drop audio files or use microphone';
      els.npTitle.textContent = 'No track'; els.npSub.textContent = '—'; els.durVal.textContent = '0:00';
    } else if (currentIdx > idx) currentIdx--;
    renderTrackList(); renderKanban();
    if (tracks.length === 0) { if (els.trackEmpty) els.trackEmpty.style.display = ''; if (els.kanbanEmp) els.kanbanEmp.style.display = ''; }
    showToast(`Deleted: ${t.name}`);
  }

  /* ════════════════════════════════════════════════════
     14. CONTROLS
  ════════════════════════════════════════════════════ */
  els.play.addEventListener('click', async () => {
    await audio.init();
    if (sourceMode === 'mic') { if (audio.isMic) { audio.stopMicStream(); setPlayUI(false); setSourceMode('file'); sourceMode = 'file'; } return; }
    if (currentIdx === -1 && tracks.length > 0) { await playTrack(0); return; }
    if (currentIdx === -1) return;
    if (isPlaying) { audio.pause(tracks[currentIdx]?.buffer); setPlayUI(false); }
    else { audio.resume(tracks[currentIdx]?.buffer); setPlayUI(true); }
  });
  els.playSb.addEventListener('click', () => els.play.click());
  els.prev.addEventListener('click', () => {
    if (currentIdx > 0) playTrack(currentIdx - 1);
    else if (currentIdx === 0) { audio.pausedAt = 0; if (isPlaying) { audio.stopSource(); audio.play(tracks[0].buffer); } }
  });
  els.next.addEventListener('click', () => { if (currentIdx < tracks.length - 1) playTrack(currentIdx + 1); });
  els.loop.addEventListener('click', () => { loopMode = !loopMode; els.loop.classList.toggle('active-chip', loopMode); });
  els.shuffle.addEventListener('click', () => { shuffleMode = !shuffleMode; els.shuffle.classList.toggle('active-chip', shuffleMode); });

  function handleFileChange(e) { const files = e.target.files; if (files?.length) loadFiles(files); e.target.value = ''; }
  els.fileIn.addEventListener('change', handleFileChange);
  els.fileIn2?.addEventListener('change', handleFileChange);

  /* ════════════════════════════════════════════════════
     15. VOLUME
  ════════════════════════════════════════════════════ */
  function setVolume(v) {
    audio.setVolume(v / 100);
    els.volSlider.value = v;
    if (els.eqVol) els.eqVol.value = v;
    els.volStat.textContent = v + '%';
    if (els.eqVolVal) els.eqVolVal.textContent = v + '%';
  }
  els.volSlider.addEventListener('input', () => setVolume(parseInt(els.volSlider.value, 10)));

  /* ════════════════════════════════════════════════════
     16. EQ CONTROLS
  ════════════════════════════════════════════════════ */
  els.eqVol?.addEventListener('input', () => { setVolume(parseInt(els.eqVol.value, 10)); scheduleSaveSettings(); });
  els.eqBass?.addEventListener('input', () => { const v = parseFloat(els.eqBass.value); audio.setBass(v); els.eqBassVal.textContent = (v>=0?'+':'')+v.toFixed(1)+' dB'; scheduleSaveSettings(); });
  els.eqMid?.addEventListener('input', () => { const v = parseFloat(els.eqMid.value); audio.setMid(v); els.eqMidVal.textContent = (v>=0?'+':'')+v.toFixed(1)+' dB'; scheduleSaveSettings(); });
  els.eqPresence?.addEventListener('input', () => { const v = parseFloat(els.eqPresence.value); audio.setPresence(v); els.eqPresenceVal.textContent = (v>=0?'+':'')+v.toFixed(1)+' dB'; scheduleSaveSettings(); });
  els.eqTreble?.addEventListener('input', () => { const v = parseFloat(els.eqTreble.value); audio.setTreble(v); els.eqTrebVal.textContent = (v>=0?'+':'')+v.toFixed(1)+' dB'; scheduleSaveSettings(); });
  els.eqAir?.addEventListener('input', () => { const v = parseFloat(els.eqAir.value); audio.setAir(v); els.eqAirVal.textContent = (v>=0?'+':'')+v.toFixed(1)+' dB'; scheduleSaveSettings(); });
  els.eqPitch?.addEventListener('input', () => { const v = parseFloat(els.eqPitch.value); audio.setPitch(v); els.eqPitchVal.textContent = (v>=0?'+':'')+v.toFixed(1)+' st'; if(currentIdx>=0&&isPlaying) audio.restartWithCurrentEffects(tracks[currentIdx]?.buffer); scheduleSaveSettings(); });
  els.eqSpeed?.addEventListener('input', () => { const rate = parseInt(els.eqSpeed.value,10)/100; audio.setPlaybackSpeed(rate); els.eqSpeedVal.textContent = rate.toFixed(2)+'×'; if(currentIdx>=0&&isPlaying) audio.restartWithCurrentEffects(tracks[currentIdx]?.buffer); scheduleSaveSettings(); });
  els.eqSmooth?.addEventListener('input', () => { const v = parseInt(els.eqSmooth.value,10); if(audio.analyser) audio.analyser.smoothingTimeConstant = v/100; els.eqSmoVal.textContent = v+'%'; });
  els.eqFadeIn?.addEventListener('input', () => { const v = parseFloat(els.eqFadeIn.value); els.eqFadeInVal.textContent = v.toFixed(1)+' s'; });
  els.eqFadeOut?.addEventListener('input', () => { const v = parseFloat(els.eqFadeOut.value); els.eqFadeOutVal.textContent = v.toFixed(1)+' s'; });

  els.eqReset?.addEventListener('click', () => {
    const d = mergeSettings();
    if (els.eqSmooth) els.eqSmooth.value = 76;
    if (audio.analyser) audio.analyser.smoothingTimeConstant = 0.76;
    if (els.eqSmoVal) els.eqSmoVal.textContent = '76%';
    if (els.eqFadeIn) { els.eqFadeIn.value = 0; els.eqFadeInVal.textContent = '0.0 s'; }
    if (els.eqFadeOut) { els.eqFadeOut.value = 0; els.eqFadeOutVal.textContent = '0.0 s'; }
    syncEqUI(d); audio.applySettings(d);
    if (currentIdx >= 0) {
      tracks[currentIdx].settings = d;
      if (isPlaying && tracks[currentIdx]?.buffer) audio.restartWithCurrentEffects(tracks[currentIdx].buffer);
      scheduleSaveSettings();
    }
  });
  els.eqSave?.addEventListener('click', saveTrackSettings);
  els.eqExport?.addEventListener('click', exportEditedAudio);

  async function exportEditedAudio() {
    if (currentIdx < 0) { showToast('Load a track before exporting'); return; }
    const t = tracks[currentIdx];
    if (!t.buffer) { showToast('Wait for track to finish loading'); return; }
    const fmt = els.exportFmt?.value || 'wav';
    showToast(`Rendering audio (${fmt.toUpperCase()})…`);
    try {
      const fadeIn  = parseFloat(els.eqFadeIn?.value || 0);
      const fadeOut = parseFloat(els.eqFadeOut?.value || 0);
      let buf = await audio.renderProcessedAudio(t.buffer);
      if (fadeIn > 0 || fadeOut > 0) buf = await fx.applyFade(buf, fadeIn, fadeOut);
      let blob;
      if (fmt === 'mp3') {
        blob = audio.audioBufferToMp3(buf, 192);
      } else {
        blob = audio.audioBufferToWav(buf, true);
      }
      if (!blob) { showToast('⚠ Export failed'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url;
      a.download = `${t.name || 'edited'}_edited.${fmt}`; a.click();
      URL.revokeObjectURL(url);
      showToast(`✓ Audio downloaded as ${fmt.toUpperCase()}`);
    } catch (err) { console.error('Export failed:', err); showToast('⚠ Export failed'); }
  }

  /* ════════════════════════════════════════════════════
     17. TRIM PANEL
  ════════════════════════════════════════════════════ */
  function drawTrimWaveform() {
    const tc = $('trim-canvas');
    if (!tc) return;
    const ctx = tc.getContext('2d');
    const W = tc.width, H = tc.height;
    ctx.clearRect(0, 0, W, H);

    const buf = currentIdx >= 0 ? tracks[currentIdx]?.buffer : null;
    const noTrack = $('trim-no-track');

    if (!buf) {
      if (noTrack) noTrack.style.display = '';
      return;
    }
    if (noTrack) noTrack.style.display = 'none';

    const ch   = buf.getChannelData(0);
    const step = Math.floor(ch.length / W);
    const mid  = H / 2;

    // Background
    ctx.fillStyle = 'rgba(160,80,255,0.04)';
    ctx.fillRect(0, 0, W, H);

    // Draw waveform
    for (let x = 0; x < W; x++) {
      let min = 1, max = -1;
      const off = x * step;
      for (let i = 0; i < step; i++) {
        const v = ch[Math.min(off + i, ch.length - 1)];
        if (v < min) min = v; if (v > max) max = v;
      }
      const dur = buf.duration;
      const timeSec = (x / W) * dur;
      const inRegion = timeSec >= trimStartSec && timeSec <= trimEndSec;
      const gr = ctx.createLinearGradient(x, mid + max * mid, x, mid + min * mid);
      if (inRegion) {
        gr.addColorStop(0, 'rgba(160,80,255,0.9)');
        gr.addColorStop(1, 'rgba(40,160,255,0.7)');
      } else {
        gr.addColorStop(0, 'rgba(100,100,140,0.5)');
        gr.addColorStop(1, 'rgba(100,100,140,0.3)');
      }
      ctx.fillStyle = gr;
      ctx.fillRect(x, mid + min * mid, 1, Math.max(1, (max - min) * mid));
    }

    // Handles visual
    const dur = buf.duration;
    const sx = (trimStartSec / dur) * W;
    const ex = (trimEndSec   / dur) * W;

    ctx.strokeStyle = 'var(--purple)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
    ctx.strokeStyle = 'var(--cyan)';
    ctx.beginPath(); ctx.moveTo(ex, 0); ctx.lineTo(ex, H); ctx.stroke();

    // Update DOM handles
    const wrap = $('trim-waveform-wrap');
    if (wrap) {
      const sh = $('trim-handle-start');
      const eh = $('trim-handle-end');
      const sel = $('trim-selection');
      const wrapW = wrap.clientWidth;
      if (sh) sh.style.left = ((trimStartSec / dur) * 100) + '%';
      if (eh) eh.style.left = ((trimEndSec   / dur) * 100) + '%';
      if (sel) {
        sel.style.left  = ((trimStartSec / dur) * 100) + '%';
        sel.style.width = (((trimEndSec - trimStartSec) / dur) * 100) + '%';
      }
    }

    // Update duration badge
    const badge = $('trim-duration-badge');
    if (badge) badge.textContent = `${fmt(trimStartSec)} → ${fmt(trimEndSec)} (${fmt(trimEndSec - trimStartSec)})`;
  }

  function updateTrimInputs() {
    const si = $('trim-start-input');
    const ei = $('trim-end-input');
    if (si) si.value = trimStartSec.toFixed(2);
    if (ei) ei.value = trimEndSec.toFixed(2);
  }

  // Trim canvas mouse drag
  const trimWrap = $('trim-waveform-wrap');
  if (trimWrap) {
    trimWrap.addEventListener('mousedown', (e) => {
      const buf = currentIdx >= 0 ? tracks[currentIdx]?.buffer : null;
      if (!buf) return;
      const rect = trimWrap.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      const timeSec = ratio * buf.duration;
      const distStart = Math.abs(timeSec - trimStartSec);
      const distEnd   = Math.abs(timeSec - trimEndSec);
      trimDragging = distStart < distEnd ? 'start' : 'end';
    });
    document.addEventListener('mousemove', (e) => {
      if (!trimDragging) return;
      const buf = currentIdx >= 0 ? tracks[currentIdx]?.buffer : null;
      if (!buf) return;
      const rect = trimWrap.getBoundingClientRect();
      const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
      const timeSec = ratio * buf.duration;
      if (trimDragging === 'start') trimStartSec = Math.min(timeSec, trimEndSec - 0.1);
      else                          trimEndSec   = Math.max(timeSec, trimStartSec + 0.1);
      updateTrimInputs();
      drawTrimWaveform();
    });
    document.addEventListener('mouseup', () => { trimDragging = null; });
  }

  // Trim input manual
  $('trim-start-input')?.addEventListener('change', (e) => {
    const buf = currentIdx >= 0 ? tracks[currentIdx]?.buffer : null;
    if (!buf) return;
    trimStartSec = Math.max(0, Math.min(parseFloat(e.target.value), trimEndSec - 0.1));
    drawTrimWaveform();
  });
  $('trim-end-input')?.addEventListener('change', (e) => {
    const buf = currentIdx >= 0 ? tracks[currentIdx]?.buffer : null;
    if (!buf) return;
    trimEndSec = Math.min(buf.duration, Math.max(parseFloat(e.target.value), trimStartSec + 0.1));
    drawTrimWaveform();
  });

  $('btn-trim-apply')?.addEventListener('click', () => {
    const buf = currentIdx >= 0 ? tracks[currentIdx]?.buffer : null;
    if (!buf) { showToast('Load a track first'); return; }
    const trimmed = audio.trimBuffer(buf, trimStartSec, trimEndSec);
    if (!trimmed) { showToast('⚠ Trim failed'); return; }
    tracks[currentIdx].buffer   = trimmed;
    tracks[currentIdx].duration = trimmed.duration;
    trimBuffer = trimmed;
    trimStartSec = 0; trimEndSec = trimmed.duration;
    updateTrimInputs(); drawTrimWaveform();
    if (isPlaying) { audio.stopSource(); audio.play(trimmed, 0); }
    renderTrackList(); renderKanban();
    showToast('✓ Trim applied');
  });

  $('btn-trim-preview')?.addEventListener('click', async () => {
    const buf = currentIdx >= 0 ? tracks[currentIdx]?.buffer : null;
    if (!buf) { showToast('Load a track first'); return; }
    await audio.init();
    const trimmed = audio.trimBuffer(buf, trimStartSec, trimEndSec);
    if (!trimmed) return;
    audio.stopSource();
    audio.play(trimmed, 0);
    setPlayUI(true);
    showToast('Previewing trimmed region…');
  });

  $('btn-trim-export')?.addEventListener('click', async () => {
    const buf = currentIdx >= 0 ? tracks[currentIdx]?.buffer : null;
    if (!buf) { showToast('Load a track first'); return; }
    showToast('Exporting trimmed audio…');
    const trimmed = audio.trimBuffer(buf, trimStartSec, trimEndSec);
    if (!trimmed) { showToast('⚠ Trim failed'); return; }
    const fmt = els.exportFmt?.value || 'wav';
    const blob = fmt === 'mp3' ? audio.audioBufferToMp3(trimmed, 192) : audio.audioBufferToWav(trimmed, true);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `${tracks[currentIdx].name || 'trimmed'}_trimmed.${fmt}`; a.click();
    URL.revokeObjectURL(url);
    showToast(`✓ Trimmed audio downloaded (${fmt.toUpperCase()})`);
  });

  $('btn-trim-reset')?.addEventListener('click', () => {
    const buf = currentIdx >= 0 ? tracks[currentIdx]?.buffer : null;
    if (!buf) return;
    trimStartSec = 0; trimEndSec = buf.duration;
    updateTrimInputs(); drawTrimWaveform();
  });

  /* ════════════════════════════════════════════════════
     18. MERGE PANEL
  ════════════════════════════════════════════════════ */
  function renderMergeGrid() {
    const grid = $('merge-track-grid');
    const emptyEl = $('merge-empty');
    if (!grid) return;
    grid.querySelectorAll('.merge-track-item').forEach(e => e.remove());

    if (!tracks.length) { if (emptyEl) emptyEl.style.display = ''; return; }
    if (emptyEl) emptyEl.style.display = 'none';

    tracks.forEach((t, i) => {
      const item = document.createElement('div');
      item.className = 'merge-track-item' + (mergeSelectedIdxs.has(i) ? ' selected' : '');
      item.dataset.idx = i;
      item.innerHTML = `<div class="merge-check"></div><span class="merge-track-label" title="${t.name}">${t.name}</span><span class="merge-track-dur">${fmt(t.duration)}</span>`;
      item.addEventListener('click', () => {
        if (mergeSelectedIdxs.has(i)) mergeSelectedIdxs.delete(i); else mergeSelectedIdxs.add(i);
        item.classList.toggle('selected', mergeSelectedIdxs.has(i));
        const mc = item.querySelector('.merge-check');
        if (mc) {
          mc.style.background = mergeSelectedIdxs.has(i) ? 'var(--purple)' : '';
          mc.style.borderColor = mergeSelectedIdxs.has(i) ? 'var(--purple)' : '';
          mc.textContent = mergeSelectedIdxs.has(i) ? '✓' : '';
        }
      });
      grid.appendChild(item);
    });
  }

  // Merge mode buttons
  $$('.merge-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.merge-mode-btn').forEach(b => b.classList.remove('active-mode'));
      btn.classList.add('active-mode');
      mergeMode = btn.dataset.mode;
    });
  });

  // Merge file input for extra files
  $('merge-file-input')?.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files).filter(f => /^audio\//.test(f.type) || /\.(mp3|wav|flac|ogg|m4a)$/i.test(f.name));
    if (!files.length) return;
    await audio.init();
    for (const file of files) {
      try {
        const ab  = await file.arrayBuffer();
        const buf = await audio.ctx.decodeAudioData(ab.slice(0));
        mergeQueueBuffers.push({ name: file.name.replace(/\.[^/.]+$/,''), buffer: buf });
        showToast(`+ ${file.name} added to merge queue`);
      } catch { showToast(`⚠ Could not decode: ${file.name}`); }
    }
    e.target.value = '';
  });

  $('btn-merge-do')?.addEventListener('click', async () => {
    const selected = Array.from(mergeSelectedIdxs).map(i => tracks[i]).filter(t => t.buffer);
    const extra    = mergeQueueBuffers.map(m => m.buffer);
    const allBufs  = [...selected.map(t => t.buffer), ...extra];

    if (allBufs.length < 2) { showToast('Select at least 2 tracks to merge'); return; }
    showToast(`Merging ${allBufs.length} tracks (${mergeMode})…`);

    try {
      const merged = audio.mergeBuffers(allBufs, mergeMode);
      if (!merged) { showToast('⚠ Merge failed'); return; }
      const blob = audio.audioBufferToWav(merged, true);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a'); a.href = url;
      a.download = `merged_${mergeMode}_${Date.now()}.wav`; a.click();
      URL.revokeObjectURL(url);
      showToast('✓ Merged audio downloaded!');
    } catch (err) { console.error('Merge error:', err); showToast('⚠ Merge failed'); }
  });

  /* ════════════════════════════════════════════════════
     19. MIX PANEL
  ════════════════════════════════════════════════════ */
  async function loadMixFile(inputId, nameId, stateVar) {
    const input = $(inputId);
    if (!input?.files?.length) return null;
    const file = input.files[0];
    await audio.init();
    try {
      const ab  = await file.arrayBuffer();
      const buf = await audio.ctx.decodeAudioData(ab.slice(0));
      const nameEl = $(nameId);
      if (nameEl) nameEl.textContent = file.name.replace(/\.[^/.]+$/, '');
      input.value = '';
      return buf;
    } catch { showToast(`⚠ Could not decode ${file.name}`); return null; }
  }

  $('mix-voice-input')?.addEventListener('change', async () => {
    mixVoiceBuffer = await loadMixFile('mix-voice-input', 'mix-voice-name');
    if (mixVoiceBuffer) showToast('✓ Voice track loaded');
  });
  $('mix-music-input')?.addEventListener('change', async () => {
    mixMusicBuffer = await loadMixFile('mix-music-input', 'mix-music-name');
    if (mixMusicBuffer) showToast('✓ Music track loaded');
  });

  $('mix-voice-vol')?.addEventListener('input', (e) => { $('mix-voice-vol-val').textContent = e.target.value + '%'; });
  $('mix-music-vol')?.addEventListener('input', (e) => { $('mix-music-vol-val').textContent = e.target.value + '%'; });
  $('noise-threshold')?.addEventListener('input', (e) => { $('noise-threshold-val').textContent = e.target.value + '%'; });
  $('silence-threshold')?.addEventListener('input', (e) => { $('silence-threshold-val').textContent = e.target.value + '%'; });

  async function doMix(preview = false) {
    let voiceBuf = mixVoiceBuffer;
    let musicBuf = mixMusicBuffer;
    // Fallback: use current track as voice
    if (!voiceBuf && currentIdx >= 0) voiceBuf = tracks[currentIdx]?.buffer;

    if (!voiceBuf && !musicBuf) { showToast('Load voice and/or music tracks first'); return null; }

    showToast('Mixing…');
    const voiceGain = parseInt($('mix-voice-vol')?.value || 100, 10) / 100;
    const musicGain = parseInt($('mix-music-vol')?.value || 50, 10) / 100;

    let mixed = audio.mixBuffers(voiceBuf, musicBuf, voiceGain, musicGain);

    if ($('toggle-noise-reduction')?.checked && mixed) {
      const threshold = parseInt($('noise-threshold')?.value || 3, 10) / 100;
      showToast('Applying noise reduction…');
      mixed = await fx.applyNoiseReduction(mixed, threshold);
    }

    if ($('toggle-silence-removal')?.checked && mixed) {
      const threshold = parseInt($('silence-threshold')?.value || 2, 10) / 100;
      showToast('Removing silence…');
      mixed = fx.removeSilence(mixed, threshold, 0.3);
    }

    if ($('toggle-normalize')?.checked && mixed) {
      mixed = fx.normalizeBuffer(mixed);
    }

    return mixed;
  }

  $('btn-mix-preview')?.addEventListener('click', async () => {
    const mixed = await doMix(true);
    if (!mixed) return;
    await audio.init();
    audio.stopSource();
    audio.play(mixed, 0);
    setPlayUI(true);
    showToast('Previewing mix…');
  });

  $('btn-mix-export')?.addEventListener('click', async () => {
    const mixed = await doMix(false);
    if (!mixed) return;
    const blob = audio.audioBufferToWav(mixed, true);
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `mix_${Date.now()}.wav`; a.click();
    URL.revokeObjectURL(url);
    showToast('✓ Mix downloaded!');
  });

  /* ════════════════════════════════════════════════════
     20. EFFECTS PANEL
  ════════════════════════════════════════════════════ */
  function setupEffectToggle(checkboxId, cardId, onEnable, onDisable) {
    const cb   = $(checkboxId);
    const card = $(cardId);
    if (!cb) return;
    cb.addEventListener('change', () => {
      if (cb.checked) { onEnable(); card?.classList.add('active-fx'); }
      else            { onDisable(); card?.classList.remove('active-fx'); }
    });
  }

  setupEffectToggle('toggle-reverb', 'fx-reverb-card',
    () => { fx.applyReverb($('reverb-type')?.value || 'hall'); showToast('Reverb enabled'); },
    () => { fx.removeReverb(); showToast('Reverb removed'); }
  );

  setupEffectToggle('toggle-echo', 'fx-echo-card',
    () => {
      const d = parseInt($('echo-delay')?.value || 30, 10) / 100;
      const f = parseInt($('echo-feedback')?.value || 40, 10) / 100;
      fx.applyEcho(d, f); showToast('Echo enabled');
    },
    () => { fx.removeEcho(); showToast('Echo removed'); }
  );

  setupEffectToggle('toggle-robot', 'fx-robot-card',
    () => { fx.applyRobotVoice(parseInt($('robot-freq')?.value || 50, 10)); showToast('Robot Voice enabled'); },
    () => { fx.removeRobotVoice(); showToast('Robot Voice removed'); }
  );

  setupEffectToggle('toggle-radio', 'fx-radio-card',
    () => { fx.applyRadioVoice(); showToast('Radio Voice enabled'); },
    () => { fx.removeRadioVoice(); showToast('Radio Voice removed'); }
  );

  setupEffectToggle('toggle-enhance', 'fx-enhance-card',
    () => { showToast('AI Voice Enhancer enabled (applies on export)'); },
    () => { showToast('AI Voice Enhancer disabled'); }
  );

  // Pitch presets
  $$('[data-semitones]').forEach(btn => {
    btn.addEventListener('click', () => {
      const st = parseInt(btn.dataset.semitones, 10);
      audio.setPitch(st);
      if (els.eqPitch) { els.eqPitch.value = st; }
      if (els.eqPitchVal) els.eqPitchVal.textContent = (st >= 0 ? '+' : '') + st + ' st';
      if (currentIdx >= 0 && isPlaying) audio.restartWithCurrentEffects(tracks[currentIdx]?.buffer);
      showToast(`Pitch: ${st >= 0 ? '+' : ''}${st} semitones`);
    });
  });

  // Effect sliders update values
  $('reverb-wet')?.addEventListener('input', (e) => { $('reverb-wet-val').textContent = e.target.value + '%'; fx.reverbWet = parseInt(e.target.value) / 100; });
  $('echo-delay')?.addEventListener('input', (e) => { $('echo-delay-val').textContent = (parseInt(e.target.value)/100).toFixed(2) + 's'; fx.echoDelaySec = parseInt(e.target.value)/100; if(fx.echoDelay) fx.echoDelay.delayTime.value = fx.echoDelaySec; });
  $('echo-feedback')?.addEventListener('input', (e) => { $('echo-feedback-val').textContent = e.target.value + '%'; fx.echoFeedbackVal = parseInt(e.target.value)/100; if(fx.echoFeedback) fx.echoFeedback.gain.value = fx.echoFeedbackVal; });
  $('robot-freq')?.addEventListener('input', (e) => { $('robot-freq-val').textContent = e.target.value + ' Hz'; fx.ringFreq = parseInt(e.target.value); if(fx.ringOsc) fx.ringOsc.frequency.value = fx.ringFreq; });

  $('btn-effects-apply')?.addEventListener('click', async () => {
    const buf = currentIdx >= 0 ? tracks[currentIdx]?.buffer : null;
    if (!buf) { showToast('Load a track first'); return; }
    const fmt = els.exportFmt?.value || 'wav';
    showToast(`Rendering with effects (${fmt.toUpperCase()})…`);
    try {
      let processed = await fx.renderWithEffects(buf, audio);
      // Apply AI enhance if checked
      if ($('toggle-enhance')?.checked) {
        processed = await fx.applyNoiseReduction(processed, 0.02);
      }
      const blob = fmt === 'mp3' ? audio.audioBufferToMp3(processed, 192) : audio.audioBufferToWav(processed, true);
      const url  = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url;
      a.download = `${tracks[currentIdx].name || 'fx'}_effects.${fmt}`; a.click();
      URL.revokeObjectURL(url);
      showToast(`✓ Effects applied and downloaded (${fmt.toUpperCase()})!`);
    } catch (err) { console.error('Effects render error:', err); showToast('⚠ Effects render failed'); }
  });

  $('btn-effects-preview')?.addEventListener('click', async () => {
    const buf = currentIdx >= 0 ? tracks[currentIdx]?.buffer : null;
    if (!buf) { showToast('Load a track first'); return; }
    showToast('Rendering preview…');
    try {
      const processed = await fx.renderWithEffects(buf, audio);
      await audio.init(); audio.stopSource(); audio.play(processed, 0);
      setPlayUI(true); showToast('Previewing with effects…');
    } catch (err) { showToast('⚠ Preview failed'); }
  });

  $('btn-effects-clear')?.addEventListener('click', () => {
    $$('[id^="toggle-"]').forEach(cb => {
      if (cb.type === 'checkbox') { cb.checked = false; cb.dispatchEvent(new Event('change')); }
    });
    $$('.effect-card').forEach(c => c.classList.remove('active-fx'));
    showToast('All effects cleared');
  });

  /* ════════════════════════════════════════════════════
     21. TRANSCRIPT PANEL
  ════════════════════════════════════════════════════ */
  const transcriptDot   = $('transcript-dot');
  const transcriptStat  = $('transcript-status-text');
  const transcriptText  = $('transcript-text');
  const transcriptInter = $('transcript-interim');
  const transcriptPh    = $('transcript-placeholder');

  tEngine.onTranscript = (full, interim, isFinal) => {
    if (transcriptText) {
      transcriptText.textContent = full;
      if (transcriptPh) transcriptPh.style.display = full ? 'none' : '';
    }
    if (transcriptInter) transcriptInter.textContent = interim || '';
  };

  tEngine.onStateChange = (state) => {
    if (transcriptDot) {
      transcriptDot.className = 'transcript-status-dot' + (state !== 'idle' ? ` ${state}` : '');
    }
    if (transcriptStat) {
      const msgs = { listening: '🔴 Listening… speak clearly', speaking: '🔊 Speaking…', idle: 'Ready — click Start Listening' };
      transcriptStat.textContent = msgs[state] || 'Ready';
    }
  };

  tEngine.onError = (err) => {
    showToast(`⚠ Speech error: ${err}`);
    tEngine.onStateChange('idle');
  };

  $('btn-stt-start')?.addEventListener('click', () => {
    const started = tEngine.startListening();
    if (started) {
      $('btn-stt-start').disabled = true;
      $('btn-stt-stop').disabled  = false;
    } else {
      showToast('⚠ Speech recognition not supported in this browser. Try Chrome.');
    }
  });

  $('btn-stt-stop')?.addEventListener('click', () => {
    tEngine.stopListening();
    $('btn-stt-start').disabled = false;
    $('btn-stt-stop').disabled  = true;
  });

  $('btn-stt-clear')?.addEventListener('click', () => {
    tEngine.clearTranscript();
    if (transcriptText) transcriptText.textContent = '';
    if (transcriptInter) transcriptInter.textContent = '';
    if (transcriptPh) transcriptPh.style.display = '';
  });

  $('btn-stt-copy')?.addEventListener('click', () => {
    const text = tEngine.transcript || '';
    if (!text) { showToast('Nothing to copy yet'); return; }
    navigator.clipboard.writeText(text).then(() => showToast('✓ Copied to clipboard!')).catch(() => showToast('⚠ Copy failed'));
  });

  /* ── TTS ── */
  function populateTTSVoices() {
    const voiceSel = $('tts-voice');
    if (!voiceSel) return;
    voiceSel.innerHTML = '<option value="">Default Voice</option>';
    const voices = tEngine.getVoices();
    voices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.name; opt.textContent = `${v.name} (${v.lang})`;
      voiceSel.appendChild(opt);
    });
  }

  $('tts-rate')?.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10) / 100;
    $('tts-rate-val').textContent = v.toFixed(1) + '×';
  });
  $('tts-pitch')?.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10) / 100;
    $('tts-pitch-val').textContent = v.toFixed(1);
  });

  $('btn-tts-speak')?.addEventListener('click', () => {
    const text = $('tts-input')?.value?.trim();
    if (!text) { showToast('Enter some text to speak'); return; }
    if (!tEngine.isTTSSupported()) { showToast('⚠ Text-to-Speech not supported in this browser'); return; }
    const opts = {
      rate:      parseInt($('tts-rate')?.value || 100, 10) / 100,
      pitch:     parseInt($('tts-pitch')?.value || 100, 10) / 100,
      voiceName: $('tts-voice')?.value || ''
    };
    tEngine.speak(text, opts);
  });

  $('btn-tts-stop')?.addEventListener('click', () => {
    tEngine.stopSpeaking();
  });

  /* ════════════════════════════════════════════════════
     21b. AI TRANSCRIPTION (Whisper)
  ════════════════════════════════════════════════════ */
  $('btn-transcribe-track')?.addEventListener('click', async () => {
    if (currentIdx < 0 || !tracks[currentIdx]) {
      showToast('⚠ Load a track first'); return;
    }
    const t = tracks[currentIdx];
    if (!t.buffer && !t.url) { showToast('⚠ Track has no audio data'); return; }

    // Convert current buffer to WAV blob for upload
    let blob;
    try {
      const buf = t.buffer;
      if (!buf) { showToast('⚠ Track not loaded into memory yet. Click play first.'); return; }
      blob = audio.audioBufferToWav(buf, false);
    } catch { showToast('⚠ Failed to prepare audio'); return; }

    const progress = $('transcribe-progress');
    const status   = $('transcribe-status');
    const btn      = $('btn-transcribe-track');
    const row      = $('transcribe-file-row');

    if (progress) progress.style.display = 'flex';
    if (row)      row.style.opacity       = '0.4';
    if (btn)      btn.disabled             = true;
    if (status)   status.textContent       = '';

    showToast('🤖 Sending to Whisper AI…');
    try {
      const form = new FormData();
      form.append('audio', blob, `${t.name || 'track'}.wav`);
      const res = await fetch('/api/transcribe', { method: 'POST', body: form });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Transcription failed');

      // Populate transcript box
      const fullText = data.text || '';
      const textEl   = $('transcript-text');
      const ph       = $('transcript-placeholder');
      const interim  = $('transcript-interim');
      if (textEl) textEl.textContent = fullText;
      if (ph)     ph.style.display   = fullText ? 'none' : '';
      if (interim) interim.textContent = '';
      if (tEngine) tEngine.transcript = fullText;

      // Switch to transcript panel and show result
      setPanel('transcript');
      if (status) status.textContent = `✓ ${data.language?.toUpperCase() || 'EN'} · ${Math.round(data.duration || 0)}s`;
      showToast(`✓ Transcribed ${Math.round(data.duration || 0)}s of ${data.language || 'speech'}`);
    } catch (err) {
      console.error('[Transcribe]', err);
      showToast(`⚠ Transcription failed: ${err.message}`);
      if (status) status.textContent = '⚠ ' + err.message;
    } finally {
      if (progress) progress.style.display = 'none';
      if (row)      row.style.opacity       = '1';
      if (btn)      btn.disabled             = false;
    }
  });

  // Check if transcription is available
  fetch('/api/config').then(r => r.json()).then(cfg => {
    const btn = $('btn-transcribe-track');
    if (!cfg.transcribeAvailable && btn) {
      btn.title = 'Set OPENAI_API_KEY on the server to enable AI transcription';
      btn.style.opacity = '0.5';
    }
  }).catch(() => {});

  /* ════════════════════════════════════════════════════
     22. PROGRESS BAR
  ════════════════════════════════════════════════════ */
  function updateProgress() {
    if (!isPlaying || sourceMode === 'mic' || currentIdx < 0) return 0;
    const t   = tracks[currentIdx]; if (!t) return 0;
    const cur = audio.getCurrentTime();
    const dur = t.duration || 1;
    const ratio = Math.min(cur / dur, 1);
    const pct   = (ratio * 100).toFixed(2);
    els.progFill.style.width  = pct + '%';
    els.progThumb.style.left  = pct + '%';
    els.timeCur.textContent   = fmt(cur);
    els.timeTotal.textContent = fmt(dur);
    return ratio;
  }

  let isDragging = false;
  function scrub(clientX) {
    if (currentIdx < 0) return;
    const rect  = els.progTrack.getBoundingClientRect();
    const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    const t = tracks[currentIdx]; if (!t) return;
    audio.pausedAt = ratio * t.duration;
    if (isPlaying) { audio.stopSource(); audio.play(t.buffer, audio.pausedAt); }
    els.progFill.style.width = (ratio * 100).toFixed(2) + '%';
    els.timeCur.textContent  = fmt(audio.pausedAt);
  }
  els.progTrack.addEventListener('mousedown', e => { isDragging = true; scrub(e.clientX); });
  document.addEventListener('mousemove', e => { if (isDragging) scrub(e.clientX); });
  document.addEventListener('mouseup', () => { isDragging = false; });
  els.progTrack.addEventListener('touchstart', e => { isDragging = true; scrub(e.touches[0].clientX); }, { passive:true });
  document.addEventListener('touchmove', e => { if (isDragging) scrub(e.touches[0].clientX); }, { passive:true });
  document.addEventListener('touchend', () => { isDragging = false; });

  /* ════════════════════════════════════════════════════
     23. DRAG AND DROP
  ════════════════════════════════════════════════════ */
  window.addEventListener('dragover', e => e.preventDefault(), false);
  window.addEventListener('dragenter', e => { e.preventDefault(); els.dropOver.classList.add('active'); }, false);
  window.addEventListener('dragleave', e => { if (!e.relatedTarget || e.relatedTarget.nodeName === 'HTML') els.dropOver.classList.remove('active'); }, false);
  window.addEventListener('drop', async e => {
    e.preventDefault(); e.stopPropagation();
    els.dropOver.classList.remove('active');
    const files = e.dataTransfer?.files;
    if (files?.length) await loadFiles(files);
  }, false);

  /* ════════════════════════════════════════════════════
     24. SEARCH
  ════════════════════════════════════════════════════ */
  els.searchIn?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    $$('.sidebar-track-item').forEach((el, i) => { el.style.display = !q || tracks[i]?.name.toLowerCase().includes(q) ? '' : 'none'; });
    $$('.track-kcard').forEach((el, i) => { el.style.display = !q || tracks[i]?.name.toLowerCase().includes(q) ? '' : 'none'; });
  });

  /* ════════════════════════════════════════════════════
     25. KEYBOARD
  ════════════════════════════════════════════════════ */
  document.addEventListener('keydown', e => {
    if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); els.play.click(); }
    if (e.code === 'KeyM') { const v = audio.volume > 0 ? 0 : 0.85; setVolume(Math.round(v * 100)); }
    if (e.code === 'ArrowLeft' && currentIdx >= 0) { const t = tracks[currentIdx]; if (t) { audio.pausedAt = Math.max(0, audio.getCurrentTime() - 5); if (isPlaying) { audio.stopSource(); audio.play(t.buffer, audio.pausedAt); } } }
    if (e.code === 'ArrowRight' && currentIdx >= 0) { const t = tracks[currentIdx]; if (t) { audio.pausedAt = Math.min(t.duration, audio.getCurrentTime() + 5); if (isPlaying) { audio.stopSource(); audio.play(t.buffer, audio.pausedAt); } } }
    if (e.code === 'ArrowUp')   playTrack(Math.max(0, currentIdx - 1));
    if (e.code === 'ArrowDown') playTrack(Math.min(tracks.length - 1, currentIdx + 1));
  });

  /* ════════════════════════════════════════════════════
     26. SETTINGS
  ════════════════════════════════════════════════════ */
  $('settings-fft')?.addEventListener('change', e => { audio.setFFTSize(parseInt(e.target.value, 10)); showToast(`FFT: ${e.target.value} bins`); });
  $('settings-decibel')?.addEventListener('change', e => { audio.setMinDecibels(parseInt(e.target.value, 10)); showToast(`Min dB: ${e.target.value}`); });
  $('settings-speed')?.addEventListener('change', e => { nebulaSpeed = parseFloat(e.target.value); showToast(`Nebula speed: ${e.target.value}x`); });
  $('settings-theme')?.addEventListener('change', e => {
    nebulaTheme = parseFloat(e.target.value);
    if (uniforms?.uTheme) uniforms.uTheme.value = nebulaTheme;
    showToast(`Nebula theme changed`);
  });
  setTimeout(() => { $('settings-fft')?.value ? null : (() => { try { $('settings-fft').value='2048'; $('settings-decibel').value='-90'; $('settings-speed').value='1.0'; $('settings-theme').value='0.0'; } catch(_) {} })(); }, 200);

  /* ════════════════════════════════════════════════════
     27. DRAWING — Spectrum, Waveform, Gauges, EQ
  ════════════════════════════════════════════════════ */
  const BAR_N = 64;
  let specViewMode = 'bars';
  els.specBars?.addEventListener('click', () => { specViewMode = 'bars'; els.specBars.classList.add('active-chip'); els.specMode.classList.remove('active-chip'); });
  els.specMode?.addEventListener('click', () => { specViewMode = 'fft'; els.specMode.classList.add('active-chip'); els.specBars.classList.remove('active-chip'); });

  /* ── Waveform zoom slider ───────────────────────────── */
  $('wf-zoom')?.addEventListener('input', (e) => {
    wfZoom = parseFloat(e.target.value);
    const zv = $('wf-zoom-val');
    if (zv) zv.textContent = wfZoom.toFixed(2).replace(/\.?0+$/, '') + '×';
    drawStaticWaveform();
  });

  /* ── Static PCM waveform (click-to-seek) ───────────── */
  function drawStaticWaveform() {
    const wfSc = $('wf-static-canvas');
    if (!wfSc || !wfStaticCtx) return;
    const W = wfSc.width, H = wfSc.height;
    wfStaticCtx.clearRect(0, 0, W, H);

    const buf = currentIdx >= 0 ? tracks[currentIdx]?.buffer : null;
    if (!buf) {
      wfStaticCtx.fillStyle = 'rgba(160,80,255,0.05)';
      wfStaticCtx.fillRect(0, 0, W, H);
      wfStaticCtx.fillStyle = 'rgba(255,255,255,0.10)';
      const dpr = Math.min(window.devicePixelRatio, 2);
      wfStaticCtx.font = `${11 * dpr}px Inter, sans-serif`;
      wfStaticCtx.textAlign = 'center';
      wfStaticCtx.fillText('Load a track to see waveform — click to seek', W / 2, H / 2 + 4 * dpr);
      return;
    }

    const ch       = buf.getChannelData(0);
    const dur      = buf.duration;
    const viewFrac = 1 / wfZoom;
    const startSamp = Math.floor(wfOffset * ch.length);
    const endSamp   = Math.min(ch.length, Math.floor((wfOffset + viewFrac) * ch.length));
    const mid       = H / 2;
    const curSec    = audio.getCurrentTime() || 0;
    const viewStart = wfOffset * dur;
    const viewEnd   = viewStart + viewFrac * dur;

    // Background
    wfStaticCtx.fillStyle = 'rgba(160,80,255,0.03)';
    wfStaticCtx.fillRect(0, 0, W, H);

    for (let x = 0; x < W; x++) {
      const off  = startSamp + Math.floor((x / W) * (endSamp - startSamp));
      const step = Math.max(1, Math.floor((endSamp - startSamp) / W));
      let min = 0, max = 0;
      for (let i = 0; i < step && (off + i) < ch.length; i++) {
        const v = ch[off + i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const sampleSec = viewStart + (x / W) * (viewEnd - viewStart);
      const played    = sampleSec <= curSec;
      const gr = wfStaticCtx.createLinearGradient(x, mid + max * mid * 0.88, x, mid + min * mid * 0.88);
      if (played) {
        gr.addColorStop(0, 'rgba(160,80,255,0.95)');
        gr.addColorStop(1, 'rgba(40,160,255,0.80)');
      } else {
        gr.addColorStop(0, 'rgba(160,150,200,0.38)');
        gr.addColorStop(1, 'rgba(100,100,150,0.22)');
      }
      wfStaticCtx.fillStyle = gr;
      wfStaticCtx.fillRect(x, mid + min * mid * 0.88, 1, Math.max(1, (max - min) * mid * 0.88));
    }

    // Centre line
    wfStaticCtx.strokeStyle = 'rgba(255,255,255,0.05)';
    wfStaticCtx.lineWidth = 1;
    wfStaticCtx.beginPath();
    wfStaticCtx.moveTo(0, mid);
    wfStaticCtx.lineTo(W, mid);
    wfStaticCtx.stroke();
  }

  // Click-to-seek on static waveform
  const wfSeekWrap = $('wf-seek-wrap');
  function seekFromWfEvent(e) {
    const buf = currentIdx >= 0 ? tracks[currentIdx]?.buffer : null;
    if (!buf || !wfSeekWrap) return;
    const rect   = wfSeekWrap.getBoundingClientRect();
    const ratio  = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    const viewFrac = 1 / wfZoom;
    const seekSec  = (wfOffset + ratio * viewFrac) * buf.duration;
    audio.pausedAt = seekSec;
    if (isPlaying) { audio.stopSource(); audio.play(buf, seekSec); }
    const cursor = $('wf-seek-cursor');
    if (cursor) { cursor.style.left = (ratio * 100).toFixed(1) + '%'; cursor.style.display = 'block'; }
    const lbl = $('wf-seek-label');
    if (lbl) lbl.textContent = fmt(seekSec);
    drawStaticWaveform();
  }
  if (wfSeekWrap) {
    wfSeekWrap.addEventListener('mousedown',   e  => { wfSeekDragging = true;  seekFromWfEvent(e); });
    document.addEventListener('mousemove',     e  => { if (wfSeekDragging) seekFromWfEvent(e); });
    document.addEventListener('mouseup',       ()  => { wfSeekDragging = false; });
    wfSeekWrap.addEventListener('touchstart',  e  => { wfSeekDragging = true;  seekFromWfEvent(e.touches[0]); }, { passive: true });
    document.addEventListener('touchmove',     e  => { if (wfSeekDragging) seekFromWfEvent(e.touches[0]); }, { passive: true });
    document.addEventListener('touchend',      () => { wfSeekDragging = false; });
  }

  /* ── Voice Compressor controls ──────────────────────── */
  function syncCompressor() {
    const enabled   = $('toggle-compressor')?.checked  || false;
    const threshold = parseInt($('comp-threshold')?.value || -24, 10);
    const ratio     = parseFloat($('comp-ratio')?.value   || 4);
    const tv = $('comp-threshold-val'); if (tv) tv.textContent = threshold + ' dB';
    const rv = $('comp-ratio-val');     if (rv) rv.textContent = ratio.toFixed(1) + ':1';
    audio.setCompressor(enabled, { threshold, ratio, knee: 6 });
  }
  $('toggle-compressor')?.addEventListener('change', syncCompressor);
  $('comp-threshold')?.addEventListener('input',     syncCompressor);
  $('comp-ratio')?.addEventListener('input',         syncCompressor);

  function drawSpectrum(freqData, t) {
    if (!sCtx) return;
    const W = els.specCanvas.width, H = els.specCanvas.height;
    sCtx.clearRect(0, 0, W, H);
    sCtx.strokeStyle = 'rgba(255,255,255,0.03)'; sCtx.lineWidth = 1;
    for (let g = 1; g <= 3; g++) { const gy = H - (g/4)*H; sCtx.beginPath(); sCtx.moveTo(0,gy); sCtx.lineTo(W,gy); sCtx.stroke(); }
    if (specViewMode === 'bars') {
      const gap  = Math.max(1, W * 0.003);
      const barW = (W - gap * (BAR_N + 1)) / BAR_N;
      for (let i = 0; i < BAR_N; i++) {
        let amp;
        if (!freqData) { amp = 0.05 + 0.04 * Math.abs(Math.sin(t * 0.9 + i * 0.2)); }
        else { const bi = Math.floor((i / BAR_N) * freqData.length * 0.72); amp = freqData[Math.min(bi, freqData.length-1)] / 255; }
        const barH = Math.max(3, amp * H * 0.9);
        const x = gap + i * (barW + gap); const y = H - barH;
        const hue = 250 + (i / BAR_N) * 110; const lum = 45 + amp * 40; const alp = 0.55 + amp * 0.45;
        const grad = sCtx.createLinearGradient(x, y, x, H);
        grad.addColorStop(0, `hsla(${hue},78%,${lum+20}%,${alp})`); grad.addColorStop(1, `hsla(${hue},78%,${lum}%,${alp * 0.55})`);
        sCtx.beginPath();
        sCtx.roundRect ? sCtx.roundRect(x, y, Math.max(1,barW), barH, [Math.min(barW*.5,3), Math.min(barW*.5,3), 1, 1]) : sCtx.rect(x, y, Math.max(1,barW), barH);
        sCtx.fillStyle = grad; sCtx.fill();
      }
    } else {
      const data = freqData || new Uint8Array(256);
      sCtx.beginPath();
      const grad = sCtx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, 'hsl(260,82%,68%)'); grad.addColorStop(0.5, 'hsl(192,92%,60%)'); grad.addColorStop(1, 'hsl(320,80%,65%)');
      sCtx.strokeStyle = grad; sCtx.lineWidth = 2;
      sCtx.shadowBlur = 8; sCtx.shadowColor = 'rgba(160,100,255,.5)';
      for (let i = 0; i < W; i++) { const bi = Math.floor((i/W)*data.length); const amp = data[Math.min(bi,data.length-1)]/255; const y = H - amp*H*0.9; i === 0 ? sCtx.moveTo(i,y) : sCtx.lineTo(i,y); }
      sCtx.stroke(); sCtx.shadowBlur = 0;
      sCtx.lineTo(W,H); sCtx.lineTo(0,H); sCtx.closePath();
      const fg = sCtx.createLinearGradient(0,0,0,H);
      fg.addColorStop(0,'rgba(160,80,255,0.15)'); fg.addColorStop(1,'transparent');
      sCtx.fillStyle = fg; sCtx.fill();
    }
  }

  function drawWaveform(freqData, progress) {
    if (!wCtx) return;
    const W = els.waveCanvas.width, H = els.waveCanvas.height;
    wCtx.clearRect(0, 0, W, H); const mid = H / 2;
    for (let i = 0; i < W; i++) {
      const amp = freqData ? freqData[Math.min(Math.floor(i/W*freqData.length*0.5),freqData.length-1)]/255*0.85 : 0.04 + 0.03*Math.abs(Math.sin(i*0.05));
      const barH = Math.max(2, amp * mid); const played = (i/W) <= progress;
      wCtx.fillStyle = played ? 'rgba(160,100,255,0.8)' : 'rgba(255,255,255,0.1)';
      wCtx.fillRect(i, mid - barH, 1, barH * 2);
    }
    wCtx.fillStyle = 'rgba(200,160,255,0.9)'; wCtx.fillRect(progress * W - 1, 0, 2, H);
  }

  const gaugeColors = { bass: ['hsl(260,82%,65%)', 'hsl(310,80%,65%)', 'rgba(160,80,255,.1)'], mid: ['hsl(192,92%,58%)', 'hsl(230,80%,65%)', 'rgba(40,180,255,.1)'], treble: ['hsl(155,68%,55%)', 'hsl(180,80%,58%)', 'rgba(60,200,130,.1)'] };

  function drawGauge(canvasEl, key, value) {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d'); const W = canvasEl.width, H = canvasEl.height;
    const cx = W/2, cy = H/2, r = W*0.37, lw = 5;
    ctx.clearRect(0, 0, W, H);
    const [ca, cb, ct] = gaugeColors[key];
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.strokeStyle = ct; ctx.lineWidth = lw; ctx.stroke();
    if (value > 0.01) {
      const end = -Math.PI/2 + value * Math.PI*2;
      const g = ctx.createLinearGradient(cx-r,cy-r,cx+r,cy+r);
      g.addColorStop(0, ca); g.addColorStop(1, cb);
      ctx.beginPath(); ctx.arc(cx,cy,r,-Math.PI/2,end); ctx.strokeStyle = g; ctx.lineWidth = lw; ctx.lineCap = 'round';
      ctx.shadowBlur = 8; ctx.shadowColor = ca; ctx.stroke(); ctx.shadowBlur = 0;
      const tx = cx + Math.cos(end)*r, ty = cy + Math.sin(end)*r;
      ctx.beginPath(); ctx.arc(tx,ty,3.5,0,Math.PI*2); ctx.fillStyle = cb; ctx.shadowBlur=10; ctx.shadowColor=cb; ctx.fill(); ctx.shadowBlur=0;
    }
  }

  function drawEqCurve(bassDb, midDb, trebleDb, presenceDb = 0, airDb = 0) {
    if (!eqCtx || !els.eqCanvas) return;
    const W = els.eqCanvas.width, H = els.eqCanvas.height;
    eqCtx.clearRect(0, 0, W, H);
    // Grid
    eqCtx.strokeStyle = 'rgba(255,255,255,0.04)'; eqCtx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) { const y = (g/4)*H; eqCtx.beginPath(); eqCtx.moveTo(0,y); eqCtx.lineTo(W,y); eqCtx.stroke(); }
    eqCtx.strokeStyle = 'rgba(255,255,255,0.08)'; eqCtx.beginPath(); eqCtx.moveTo(0,H/2); eqCtx.lineTo(W,H/2); eqCtx.stroke();

    const grad = eqCtx.createLinearGradient(0,0,W,0);
    grad.addColorStop(0,    'hsla(260,82%,68%,0.9)');
    grad.addColorStop(0.3,  'hsla(192,92%,60%,0.9)');
    grad.addColorStop(0.65, 'hsla(200,82%,65%,0.9)');
    grad.addColorStop(1,    'hsla(155,68%,55%,0.9)');

    eqCtx.beginPath();
    for (let i = 0; i < W; i++) {
      // Logarithmic frequency mapping 20Hz – 20kHz
      const f = 20 * Math.pow(1000, i / W);
      // Each band: Gaussian approximation of biquad response
      const bassC     = Math.exp(-Math.pow(Math.log10(f / 100),  2) * 3.5)  * bassDb;
      const midC      = Math.exp(-Math.pow(Math.log10(f / 800),  2) * 3.0)  * midDb;
      const presenceC = Math.exp(-Math.pow(Math.log10(f / 3500), 2) * 4.0)  * presenceDb;
      const trebleC   = Math.exp(-Math.pow(Math.log10(f / 5000), 2) * 2.5)  * trebleDb;
      const airC      = Math.exp(-Math.pow(Math.log10(f / 12000), 2) * 3.0) * airDb;
      const total     = bassC + midC + presenceC + trebleC + airC;
      const y = H/2 - (total / 15) * (H/2 - 4);
      i === 0 ? eqCtx.moveTo(0, y) : eqCtx.lineTo(i, y);
    }
    eqCtx.strokeStyle = grad; eqCtx.lineWidth = 2;
    eqCtx.shadowBlur = 6; eqCtx.shadowColor = 'rgba(160,100,255,.5)'; eqCtx.stroke(); eqCtx.shadowBlur = 0;
    eqCtx.lineTo(W,H/2); eqCtx.lineTo(0,H/2); eqCtx.closePath();
    const fg = eqCtx.createLinearGradient(0,0,0,H);
    fg.addColorStop(0,'rgba(160,80,255,0.12)'); fg.addColorStop(1,'transparent');
    eqCtx.fillStyle = fg; eqCtx.fill();
  }

  function drawNpCover(idx) {
    if (!npCtx) return;
    const W = els.npCanvas.width, H = els.npCanvas.height;
    npCtx.clearRect(0,0,W,H);
    const hue = (idx * 137.5) % 360;
    const g = npCtx.createRadialGradient(W/2,H/2,4,W/2,H/2,W);
    g.addColorStop(0, `hsl(${hue},80%,60%)`); g.addColorStop(1, `hsl(${(hue+120)%360},70%,30%)`);
    npCtx.fillStyle = g; npCtx.fillRect(0,0,W,H);
    npCtx.strokeStyle='rgba(255,255,255,0.2)'; npCtx.lineWidth=1.5;
    for (let i = 0; i < 4; i++) {
      const y = (i+1)*H/5; npCtx.beginPath(); npCtx.moveTo(4,y);
      for (let x=4; x<W-4; x+=2) npCtx.lineTo(x, y + Math.sin(x*.3+i)*5); npCtx.stroke();
    }
  }

  /* ════════════════════════════════════════════════════
     28. TOAST
  ════════════════════════════════════════════════════ */
  let toastTimeout;
  function showToast(msg) {
    let t = $('toast');
    if (!t) {
      t = document.createElement('div'); t.id = 'toast';
      t.style.cssText = `position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:rgba(20,15,45,0.96);color:#fff;padding:10px 22px;border-radius:999px;font-size:.8rem;font-family:Inter,sans-serif;z-index:9999;border:1px solid rgba(160,100,255,.35);box-shadow:0 4px 24px rgba(0,0,0,.6),0 0 0 1px rgba(160,80,255,.1);pointer-events:none;transition:opacity .3s ease;`;
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { t.style.opacity = '0'; }, 3500);
  }

  /* ════════════════════════════════════════════════════
     29. FPS + IDLE + BPM
  ════════════════════════════════════════════════════ */
  let fpsBuf = [], lastFT = performance.now();
  function sampleFPS(now) {
    fpsBuf.push(now - lastFT); lastFT = now;
    if (fpsBuf.length > 30) fpsBuf.shift();
    return Math.round(1000 / (fpsBuf.reduce((a,b)=>a+b,0) / fpsBuf.length));
  }

  function idleBands(t) { return { bass: 0.07 + 0.04*Math.sin(t*.55), mid: 0.04 + 0.025*Math.sin(t*.85+1), treble: 0.02 + 0.015*Math.sin(t*1.25+2.2) }; }

  let bpmHist = [], lastBeat = 0, bpmEst = 0;
  function detectBPM(bass, t) {
    if (bass > 0.28 && t - lastBeat > 0.25) {
      if (lastBeat > 0) { bpmHist.push(60 / (t - lastBeat)); if (bpmHist.length > 16) bpmHist.shift(); bpmEst = Math.round(bpmHist.reduce((a,b)=>a+b,0)/bpmHist.length); }
      lastBeat = t;
    }
    return bpmEst;
  }

  /* ════════════════════════════════════════════════════
     30. MAIN ANIMATION LOOP
  ════════════════════════════════════════════════════ */
  let frame = 0;

  function animate(now) {
    requestAnimationFrame(animate);
    const t = now * .001;
    if (lastTime === 0) lastTime = now;
    const delta = (now - lastTime) * 0.001; lastTime = now;
    shaderTime += Math.min(delta, 0.1) * nebulaSpeed;
    if (uniforms) { uniforms.uTime.value = shaderTime; uniforms.uTheme.value = nebulaTheme; }

    let bands, freqData;
    if (audio.isPlaying || (audio.analyser && audio.isMic)) { bands = audio.analyse(); freqData = audio.freqData; }
    else { bands = idleBands(t); freqData = null; }

    if (uniforms) {
      uniforms.uBass.value   += (bands.bass   - uniforms.uBass.value)   * .12;
      uniforms.uMid.value    += (bands.mid    - uniforms.uMid.value)    * .10;
      uniforms.uTreble.value += (bands.treble - uniforms.uTreble.value) * .14;
    }

    const ratio = updateProgress();
    drawSpectrum(freqData, t);
    if (frame % 2 === 0) drawWaveform(freqData, ratio);

    if (frame % 2 === 0) {
      drawGauge(els.gaugeBass, 'bass', bands.bass);
      drawGauge(els.gaugeMid,  'mid',  bands.mid);
      drawGauge(els.gaugeTreb, 'treble', bands.treble);
      els.gvBass.textContent   = Math.round(bands.bass   * 100);
      els.gvMid.textContent    = Math.round(bands.mid    * 100);
      els.gvTreb.textContent   = Math.round(bands.treble * 100);
      els.fbBass.style.width   = (bands.bass   * 100).toFixed(1) + '%';
      els.fbMid.style.width    = (bands.mid    * 100).toFixed(1) + '%';
      els.fbTreble.style.width = (bands.treble * 100).toFixed(1) + '%';
      const peak = Math.max(bands.bass, bands.mid, bands.treble);
      els.peakVal.textContent = Math.round(peak * 100) + '%';
      els.bpmVal.textContent  = detectBPM(bands.bass, t) || '—';
    }

    if (frame % 10 === 0 && els.panelEq?.style.display !== 'none') {
      drawEqCurve(
        parseFloat(els.eqBass?.value     || 0),
        parseFloat(els.eqMid?.value      || 0),
        parseFloat(els.eqTreble?.value   || 0),
        parseFloat(els.eqPresence?.value || 0),
        parseFloat(els.eqAir?.value      || 0)
      );
    }

    // Refresh static waveform every 8 frames (seek cursor + played fill)
    if (frame % 8 === 0 && currentIdx >= 0) {
      drawStaticWaveform();
      // Update wf-seek-cursor position
      const t = tracks[currentIdx];
      if (t && t.buffer && isPlaying) {
        const dur  = t.buffer.duration;
        const cur  = audio.getCurrentTime();
        const viewFrac = 1 / wfZoom;
        const viewStart = wfOffset * dur;
        const viewEnd   = viewStart + viewFrac * dur;
        const cursor = $('wf-seek-cursor');
        const lbl    = $('wf-seek-label');
        if (cursor && cur >= viewStart && cur <= viewEnd) {
          const pct = ((cur - viewStart) / (viewEnd - viewStart)) * 100;
          cursor.style.left    = pct.toFixed(1) + '%';
          cursor.style.display = 'block';
          if (lbl) lbl.textContent = fmt(cur);
        } else if (cursor) {
          cursor.style.display = 'none';
        }
      }
    }

    if (frame % 60 === 0 && els.panelTrim?.style.display !== 'none') {
      drawTrimWaveform();
    }

    if (frame % 30 === 0) els.fpsEl.textContent = sampleFPS(now) + ' FPS';
    updateCursor();
    if (renderer && scene && camera) renderer.render(scene, camera);
    frame++;
  }

  requestAnimationFrame(animate);

  /* ════════════════════════════════════════════════════
     31. ENTRY ANIMATIONS
  ════════════════════════════════════════════════════ */
  [
    { el: $('sidebar'), delay: .05 }, { el: $('topbar'), delay: .1 },
    { el: document.querySelector('.stat-row'), delay: .2 },
    { el: document.querySelector('.main-grid'), delay: .35 },
    { el: document.querySelector('.kanban-section'), delay: .5 },
    { el: $('player-bar'), delay: .15 },
  ].forEach(({ el, delay }) => {
    if (!el) return;
    el.style.opacity = '0'; el.style.transform = 'translateY(10px)';
    setTimeout(() => {
      el.style.transition = 'opacity .7s cubic-bezier(.22,1,.36,1), transform .7s cubic-bezier(.22,1,.36,1)';
      el.style.opacity    = '1'; el.style.transform  = 'translateY(0)';
    }, delay * 1000);
  });

  /* ════════════════════════════════════════════════════
     32. FETCH SERVER TRACKS
  ════════════════════════════════════════════════════ */
  async function fetchServerTracks() {
    try {
      const res = await fetch('/api/tracks');
      if (!res.ok) return;
      const serverTracks = await res.json();
      if (!serverTracks?.length) return;
      const existingUrls = new Set(tracks.map(t => t.url).filter(Boolean));
      let added = 0;
      for (const st of serverTracks) {
        if (existingUrls.has(st.url)) continue;
        tracks.push({ name: st.name, ext: st.ext, size: st.size, url: st.url, filename: st.filename, duration: st.duration || 0, settings: mergeSettings(st.settings), buffer: null });
        added++;
      }
      if (added > 0) {
        els.libCount.textContent = tracks.length;
        if (els.trackEmpty) els.trackEmpty.style.display = 'none';
        if (els.kanbanEmp)  els.kanbanEmp.style.display  = 'none';
        renderTrackList(); renderKanban();
        showToast(`✓ Loaded ${added} track${added > 1 ? 's' : ''} from library`);
      }
      prefetchTrackBuffers();
    } catch (err) { console.warn('Backend not reachable:', err); }
  }

  async function prefetchTrackBuffers() {
    await audio.init();
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]; if (t.buffer || !t.url) continue;
      try {
        const response = await fetch(t.url); if (!response.ok) continue;
        const arrayBuffer = await response.arrayBuffer();
        t.buffer = await audio.ctx.decodeAudioData(arrayBuffer);
        if (!t.duration) t.duration = t.buffer.duration;
        renderTrackList(); renderKanban();
      } catch (err) { console.warn('Prefetch failed for', t.name, err); }
    }
  }

  setTimeout(() => {
    resizeCanvases();
    drawNpCover(0);
    fetchServerTracks();
    populateTTSVoices();
  }, 200);

})();
