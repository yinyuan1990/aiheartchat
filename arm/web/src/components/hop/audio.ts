// Chicken Cross sounds, all synthesised with Web Audio (no files). The AudioContext can only start inside a user
// gesture, so unlock() is called from start / input.

const MUTE_KEY = "arm-hop-muted";

export class HopAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise: AudioBuffer | null = null;
  muted: boolean;

  constructor() {
    let m = false;
    try { m = localStorage.getItem(MUTE_KEY) === "1"; } catch { /* private mode */ }
    this.muted = m;
  }

  unlock() {
    if (this.ctx) { if (this.ctx.state === "suspended") void this.ctx.resume(); return; }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(this.ctx.destination);
    const n = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.6, this.ctx.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = n;
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, at = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + at;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private burst(dur: number, vol: number, freq: number, q = 0.8) {
    if (!this.ctx || !this.noise) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(freq * 0.3, t + dur);
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t);
    s.stop(t + dur);
  }

  /** a step: a short chirp that climbs a little with the streak */
  hop(streak = 0) { this.tone("square", 520 + Math.min(streak, 12) * 25, 900 + Math.min(streak, 12) * 30, 0.07, 0.07); }
  bump() { this.tone("sine", 160, 90, 0.08, 0.15); }
  /** every 25 lanes */
  milestone() { [660, 880, 1320].forEach((f, i) => this.tone("triangle", f, f, 0.12, 0.12, i * 0.07)); }
  honk() { this.tone("square", 420, 400, 0.22, 0.06); this.tone("square", 530, 500, 0.22, 0.05); }
  splat() { this.burst(0.35, 0.9, 1800); this.tone("sine", 180, 40, 0.35, 0.5); this.honk(); }
  eagle() { this.tone("sawtooth", 2400, 700, 0.6, 0.12); this.burst(0.5, 0.4, 3000, 2); }
  start() { this.tone("triangle", 660, 990, 0.1, 0.12); this.tone("triangle", 990, 1320, 0.1, 0.1, 0.09); }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem(MUTE_KEY, m ? "1" : "0"); } catch { /* private mode */ }
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.03);
  }

  dispose() {
    void this.ctx?.close();
    this.ctx = null;
  }
}
