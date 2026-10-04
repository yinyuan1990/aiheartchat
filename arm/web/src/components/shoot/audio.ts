// Synthesized sound (Web Audio, no files): shots, hits, kills that climb in pitch with the combo, explosions.
// The AudioContext can only start inside a user gesture, so unlock() is called from start / pointer input.

const MUTE_KEY = "arm-shoot-muted";

export class ShootAudio {
  private ctx: BaseAudioContext | null = null;
  /** offline rendering sets this so every call schedules at a given time instead of "now" */
  clock: number | null = null;
  private now() { return this.clock ?? this.ctx!.currentTime; }
  private master!: GainNode;
  private noise!: AudioBuffer;
  muted: boolean;
  /** the 音效 debug switch: off = silent without touching the saved mute */
  enabled = true;

  constructor() {
    let m = false;
    try { m = localStorage.getItem(MUTE_KEY) === "1"; } catch { /* private mode */ }
    this.muted = m;
  }

  private level() { return this.muted || !this.enabled ? 0 : 0.55; }

  unlock(given?: BaseAudioContext) {
    if (this.ctx) { if (this.ctx.state === "suspended" && this.ctx instanceof AudioContext) void this.ctx.resume(); return; }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!given && !Ctx) return;
    const ctx = given ?? new Ctx();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.level();
    this.master.connect(comp);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  private burst(dur: number, type: BiquadFilterType, f0: number, f1: number, peak: number, q = 1, delay = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = this.now() + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, t);
    flt.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.006, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.8);
    src.stop(t + dur + 0.05);
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, peak: number, delay = 0, attack = 0.004) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = this.now() + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** player gun: a short laser blip, kept quiet because it fires 9 times a second */
  shot(twin = false) {
    this.tone("square", 1700, 480, 0.06, twin ? 0.05 : 0.04);
    this.burst(0.03, "highpass", 5000, 3000, 0.05, 0.7);
  }

  /** bullet hits an enemy that survives */
  hit(crit: boolean) {
    this.tone("triangle", crit ? 1500 : 980, crit ? 500 : 360, crit ? 0.08 : 0.05, crit ? 0.22 : 0.13);
    this.burst(0.05, "bandpass", 3200, 1400, crit ? 0.3 : 0.18, 2);
    if (crit) this.tone("sine", 2600, 2400, 0.12, 0.07, 0.01);
  }

  /** enemy destroyed: the pop climbs a semitone per combo step (two octaves max), so a streak sounds like a run */
  kill(combo: number, big: boolean) {
    const f = 330 * 2 ** (Math.min(combo, 24) / 12);
    this.tone("square", f, f * 0.5, 0.12, 0.1);
    this.tone("sine", f * 2, f * 1.5, 0.09, 0.08, 0.015);
    this.burst(big ? 0.7 : 0.28, "lowpass", big ? 2400 : 3200, 120, big ? 0.9 : 0.5, 0.8);
    this.tone("sine", big ? 140 : 110, 35, big ? 0.6 : 0.22, big ? 0.9 : 0.45);
    if (big) {
      this.burst(1.4, "bandpass", 1800, 200, 0.35, 0.7, 0.05);
      for (const [fr, a] of [[392, 0.09], [523, 0.08], [784, 0.07]] as const) this.tone("triangle", fr * 2, fr * 2, 0.18, a, 0.08 + fr / 9000);
    }
  }

  /** the combo multiplier went up a step */
  levelUp(mult: number) {
    const base = 520 * (1 + (mult - 1) * 0.35);
    [0, 4, 7, 12].forEach((s, i) => this.tone("square", base * 2 ** (s / 12), base * 2 ** (s / 12), 0.1, 0.06, i * 0.05));
  }

  comboBreak() {
    this.tone("sawtooth", 420, 140, 0.35, 0.07);
    this.tone("sawtooth", 300, 100, 0.35, 0.05, 0.06);
  }

  enemyShot() {
    this.tone("sine", 700, 300, 0.12, 0.04);
  }

  die() {
    this.tone("sine", 160, 25, 1.2, 1);
    this.burst(1.2, "lowpass", 4000, 80, 1, 0.7);
    this.burst(2.4, "bandpass", 1600, 120, 0.4, 0.6, 0.1);
    this.tone("sawtooth", 880, 55, 1.1, 0.12, 0.05);
  }

  start() {
    [0, 5, 9, 12].forEach((s, i) => this.tone("square", 440 * 2 ** (s / 12), 440 * 2 ** (s / 12), 0.09, 0.06, i * 0.06));
  }

  private applyLevel() {
    if (this.ctx) this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.03);
  }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem(MUTE_KEY, m ? "1" : "0"); } catch { /* private mode */ }
    this.applyLevel();
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.applyLevel();
  }

  dispose() {
    if (this.ctx instanceof AudioContext) void this.ctx.close();
    this.ctx = null;
  }
}

/** Calls the engine makes on ShootAudio, recorded with game time so a capture can be scored afterwards. */
export type AudioLog = [number, string, unknown[]][];
const LOGGED = new Set(["shot", "hit", "kill", "levelUp", "comboBreak", "enemyShot", "die", "start", "setEnabled"]);

/** Wraps a ShootAudio so the listed calls are logged (at clock()) instead of played. */
export function recordingAudio(real: ShootAudio, log: AudioLog, clock: () => number): ShootAudio {
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
  const a = new ShootAudio();
  a.muted = false;
  a.unlock(ctx);
  const api = a as unknown as Record<string, (...x: unknown[]) => void>;
  for (const [t, name, args] of log) {
    if (name === "setEnabled") { a.enabled = args[0] as boolean; continue; }
    if (t < t0 || t - t0 > seconds || !a.enabled) continue;
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
