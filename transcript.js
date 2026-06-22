/* =====================================================
   AudioForge AI — Transcript Module
   Speech-to-Text (Web Speech API)
   Text-to-Speech (Web Speech Synthesis API)
   ===================================================== */

class TranscriptEngine {
  constructor() {
    this.recognition    = null;
    this.synthesis      = window.speechSynthesis || null;
    this.voices         = [];
    this.transcript     = '';
    this.isListening    = false;
    this.isSpeaking     = false;
    this.onTranscript   = null;  // callback(text, isFinal)
    this.onError        = null;  // callback(error)
    this.onStateChange  = null;  // callback(state)

    this._loadVoices();
  }

  /* ── SPEECH-TO-TEXT ──────────────────────────────────── */
  isSTTSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  startListening(lang = 'en-US') {
    if (!this.isSTTSupported()) {
      if (this.onError) this.onError('Speech recognition not supported in this browser');
      return false;
    }
    if (this.isListening) return false;

    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRec();
    this.recognition.continuous    = true;
    this.recognition.interimResults = true;
    this.recognition.lang          = lang;
    this.recognition.maxAlternatives = 1;

    this.recognition.onstart = () => {
      this.isListening = true;
      if (this.onStateChange) this.onStateChange('listening');
    };

    this.recognition.onresult = (event) => {
      let interim = '';
      let final   = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript + ' ';
        } else {
          interim += result[0].transcript;
        }
      }

      if (final) {
        this.transcript += final;
        if (this.onTranscript) this.onTranscript(this.transcript, interim, true);
      } else if (interim) {
        if (this.onTranscript) this.onTranscript(this.transcript, interim, false);
      }
    };

    this.recognition.onerror = (event) => {
      if (this.onError) this.onError(event.error);
      this.isListening = false;
      if (this.onStateChange) this.onStateChange('idle');
    };

    this.recognition.onend = () => {
      this.isListening = false;
      if (this.onStateChange) this.onStateChange('idle');
    };

    this.recognition.start();
    return true;
  }

  stopListening() {
    if (this.recognition && this.isListening) {
      this.recognition.stop();
      this.isListening = false;
    }
  }

  clearTranscript() {
    this.transcript = '';
    if (this.onTranscript) this.onTranscript('', '', true);
  }

  /* ── TEXT-TO-SPEECH ──────────────────────────────────── */
  isTTSSupported() {
    return !!this.synthesis;
  }

  _loadVoices() {
    if (!this.synthesis) return;
    const load = () => {
      this.voices = this.synthesis.getVoices();
    };
    load();
    this.synthesis.onvoiceschanged = load;
  }

  getVoices() {
    return this.voices;
  }

  getVoicesByLang(lang = 'en') {
    return this.voices.filter(v => v.lang.startsWith(lang));
  }

  speak(text, options = {}) {
    if (!this.synthesis || !text.trim()) return false;

    // Cancel ongoing speech
    this.synthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate   = options.rate  || 1.0;
    utterance.pitch  = options.pitch || 1.0;
    utterance.volume = options.volume || 1.0;
    utterance.lang   = options.lang  || 'en-US';

    if (options.voiceName) {
      const voice = this.voices.find(v => v.name === options.voiceName);
      if (voice) utterance.voice = voice;
    }

    utterance.onstart = () => {
      this.isSpeaking = true;
      if (this.onStateChange) this.onStateChange('speaking');
    };

    utterance.onend = () => {
      this.isSpeaking = false;
      if (this.onStateChange) this.onStateChange('idle');
    };

    utterance.onerror = (e) => {
      this.isSpeaking = false;
      if (this.onError) this.onError(e.error);
      if (this.onStateChange) this.onStateChange('idle');
    };

    this.synthesis.speak(utterance);
    return true;
  }

  stopSpeaking() {
    if (this.synthesis) {
      this.synthesis.cancel();
      this.isSpeaking = false;
      if (this.onStateChange) this.onStateChange('idle');
    }
  }

  pauseSpeaking() {
    if (this.synthesis && this.isSpeaking) this.synthesis.pause();
  }

  resumeSpeaking() {
    if (this.synthesis) this.synthesis.resume();
  }

  /* ── TRANSCRIBE FROM AUDIO BUFFER ───────────────────── */
  // Uses a round-trip: play the audio through a hidden Audio element,
  // capture with Web Speech API (mic must be active, limited support)
  // For file-based transcription we use the microphone-based approach
  transcribeNote(note) {
    // Append a note/entry to the transcript
    const timestamp = new Date().toLocaleTimeString();
    const entry = `[${timestamp}] ${note}\n`;
    this.transcript += entry;
    return entry;
  }
}
