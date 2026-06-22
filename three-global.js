/*
 * AudioForge AI — Three.js Bootstrap
 * Imports THREE as ESM, sets it as a global, then
 * dynamically loads all app scripts in dependency order.
 */
import * as THREE from '/vendor/three/three.module.min.js';
window.THREE = THREE;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.body.appendChild(s);
  });
}

// Load app scripts sequentially AFTER THREE is ready
loadScript('/audio.js')
  .then(() => loadScript('/effects.js'))
  .then(() => loadScript('/transcript.js'))
  .then(() => loadScript('/shader.js'))
  .then(() => loadScript('/main.js'))
  .catch(err => console.error('[AudioForge] Script load error:', err));
