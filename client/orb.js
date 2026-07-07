// Reactive orb visualizer for loremaster.
//
// Adapted from the approach in smolagents/hf-realtime-voice's orb-visualizer.js
// (see ../README.md Credits): drive an orb entirely through CSS custom
// properties written on <html>, so all the visual styling lives in CSS. We feed
// it two AnalyserNodes — the mic (while you speak) and Bram's Polly output
// (while he speaks) — and it publishes a 5-band level meter (--bar0..--bar4)
// plus a global glow/scale (--level). CSS in index.html renders the rest.
//
// Differences from the fork: analysers come and go with each push-to-talk /
// playback session, so setSource() swaps the active analyser at runtime and the
// loop tolerates a null source (orb falls to rest).

export const ORB_FFT_SIZE = 256;

// Frequency-band edges (bin indices), low-biased where speech energy sits —
// same split the fork used.
const BAND_EDGES = [2, 5, 9, 16, 28, 52];
const ATTACK = 0.6;   // fast rise
const RELEASE = 0.18; // slow decay

export class Orb {
  constructor() {
    this._analyser = null;
    this._bins = new Uint8Array(ORB_FFT_SIZE / 2);
    this._bars = [0, 0, 0, 0, 0];
    this._level = 0;
    this._raf = 0;
    this._root = document.documentElement;
  }

  // Point the orb at an AnalyserNode (mic or output), or null to idle.
  setSource(analyser) {
    this._analyser = analyser;
  }

  start() {
    if (this._raf) return;
    const tick = () => {
      this._update();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._analyser = null;
    for (let i = 0; i < 5; i++) this._root.style.setProperty(`--bar${i}`, "0");
    this._root.style.setProperty("--level", "0");
  }

  _update() {
    let targetBars = [0, 0, 0, 0, 0];
    let peak = 0;
    if (this._analyser) {
      this._analyser.getByteFrequencyData(this._bins);
      for (let b = 0; b < 5; b++) {
        const lo = BAND_EDGES[b], hi = BAND_EDGES[b + 1];
        let sum = 0;
        for (let i = lo; i < hi; i++) { sum += this._bins[i]; if (this._bins[i] > peak) peak = this._bins[i]; }
        targetBars[b] = sum / ((hi - lo) * 255); // 0..1
      }
    }
    const targetLevel = peak / 255;
    for (let b = 0; b < 5; b++) {
      const w = targetBars[b] > this._bars[b] ? ATTACK : RELEASE;
      this._bars[b] += (targetBars[b] - this._bars[b]) * w;
      this._root.style.setProperty(`--bar${b}`, this._bars[b].toFixed(3));
    }
    const lw = targetLevel > this._level ? ATTACK : RELEASE;
    this._level += (targetLevel - this._level) * lw;
    this._root.style.setProperty("--level", this._level.toFixed(3));
  }
}
