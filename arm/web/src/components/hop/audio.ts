// Chicken Cross sounds, all synthesised with Web Audio (no files). The AudioContext can only start inside a user
// gesture, so unlock() is called from start / input.

const MUTE_KEY = "arm-hop-muted";

export class HopAudio {
  private ctx: BaseAudioContext | null = null;
  /** offline rendering sets this so every call schedules at a given time instead of "now" */
  clock: number | null = null;
  private master!: GainNode;
  private noise: AudioBuffer | null = null;
  muted: boolean;

  constructor() {
    let m = false;
    try { m = localStorage.getItem(MUTE_KEY) === "1"; } catch { /* private mode */ }
    this.muted = m;
  }

  private now() { return this.clock ?? this.ctx!.currentTime; }

  unlock(given?: BaseAudioContext) {
    if (this.ctx) { if (this.ctx.state === "suspended" && this.ctx instanceof AudioContext) void this.ctx.resume(); return; }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!given && !Ctx) return;
    const ctx = given ?? new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(ctx.destination);
    const n = ctx.createBuffer(1, ctx.sampleRate * 0.6, ctx.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = n;
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, at = 0) {
    if (!this.ctx) return;
    const t = this.now() + at;
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
    const t = this.now();
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
    if (this.ctx instanceof AudioContext) void this.ctx.close();
    this.ctx = null;
  }
}

/** Calls the engine makes on HopAudio, recorded with game time so a capture can be scored afterwards. */
export type AudioLog = [number, string, unknown[]][];
const LOGGED = new Set(["hop", "bump", "milestone", "honk", "splat", "eagle", "start"]);

/** Wraps a HopAudio so the listed calls are logged (at clock()) instead of played. */
export function recordingAudio(real: HopAudio, log: AudioLog, clock: () => number): HopAudio {
  return new Proxy(real, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof prop !== "string" || typeof v !== "function") return v;
      if (LOGGED.has(prop)) return (...args: unknown[]) => { log.push([clock(), prop, args]); };
      if (prop === "unlock") return () => {};
      return v.bind(target);
    },
  });
}

/** Replay a log offline (times relative to t0) and return a 16-bit stereo WAV. */
export async function renderLog(log: AudioLog, t0: number, seconds: number) {
  const sr = 44100;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
  const a = new HopAudio();
  a.muted = false;
  a.unlock(ctx);
  const api = a as unknown as Record<string, (...x: unknown[]) => void>;
  for (const [t, name, args] of log) {
    if (t < t0 || t - t0 > seconds) continue;
    a.clock = t - t0;
    api[name](...args);
  }
  const buf = await ctx.startRendering();
  const n = buf.length, L = buf.getChannelData(0), R = buf.getChannelData(1);
  const out = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); out.setUint32(4, 36 + n * 4, true); str(8, "WAVE"); str(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 2, true); out.setUint32(24, sr, true);
  out.setUint32(28, sr * 4, true); out.setUint16(32, 4, true); out.setUint16(34, 16, true); str(36, "data"); out.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 0x7fff, true);
    out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}
