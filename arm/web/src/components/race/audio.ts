// Synthesized sound (Web Audio, no files): engine with gear changes, wind, tyre squeal, horn, crash.
// The AudioContext can only start inside a user gesture, so unlock() is called from start / steer input.

const MUTE_KEY = "arm-race-muted";
// shift points in world units / s; the engine note climbs inside a gear and drops on every shift
const GEARS = [0, 9, 17, 25, 33, 41, 60];

export class RaceAudio {
  private ctx: BaseAudioContext | null = null;
  /** offline rendering sets this so every call schedules at a given time instead of "now" */
  clock: number | null = null;
  private now() { return this.clock ?? this.ctx!.currentTime; }
  private master!: GainNode;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private oscA!: OscillatorNode;
  private oscB!: OscillatorNode;
  private oscC!: OscillatorNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private gear = 0;
  private shiftDip = 0;
  muted: boolean;

  constructor() {
    let m = false;
    try { m = localStorage.getItem(MUTE_KEY) === "1"; } catch { /* private mode */ }
    this.muted = m;
  }

  unlock(given?: BaseAudioContext) {
    if (this.ctx) { if (this.ctx.state === "suspended" && this.ctx instanceof AudioContext) void this.ctx.resume(); return; }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!given && !Ctx) return;
    const ctx = given ?? new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.6;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // engine: saw + square an octave down + a detuned saw, soft-clipped and low-passed
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(x * 2.2); }
    shaper.curve = curve;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.Q.value = 4;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.oscA = ctx.createOscillator();
    this.oscA.type = "sawtooth";
    this.oscB = ctx.createOscillator();
    this.oscB.type = "square";
    this.oscC = ctx.createOscillator();
    this.oscC.type = "sawtooth";
    this.oscC.detune.value = 18;
    const bGain = ctx.createGain();
    bGain.gain.value = 0.35;
    const cGain = ctx.createGain();
    cGain.gain.value = 0.5;
    this.oscA.connect(shaper);
    this.oscB.connect(bGain).connect(shaper);
    this.oscC.connect(cGain).connect(shaper);
    shaper.connect(this.engineFilter).connect(this.engineGain).connect(this.master);
    this.oscA.start();
    this.oscB.start();
    this.oscC.start();

    // wind / tyre roar: looped noise through a low-pass that opens with speed
    const wind = ctx.createBufferSource();
    wind.buffer = this.noise;
    wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "lowpass";
    this.windFilter.Q.value = 0.4;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(this.windFilter).connect(this.windGain).connect(this.master);
    wind.start();
  }

  /** speed in world units / s, top = top speed; alive = engine running; air = wheels off the road. Called every frame. */
  update(speed: number, top: number, alive: boolean, air = false, dt = 0.016) {
    if (!this.ctx) return;
    const t = this.now();
    let g = 0;
    while (g < GEARS.length - 2 && speed > GEARS[g + 1]) g++;
    if (g > this.gear) this.shiftDip = 0.18;
    this.gear = g;
    this.shiftDip = Math.max(0, this.shiftDip - dt);
    const rpm = Math.min(1, (speed - GEARS[g]) / (GEARS[g + 1] - GEARS[g]));
    const sp = Math.min(1, speed / top);
    const f = (55 + 70 * rpm + 18 * g) * (air ? 1.35 : 1);
    this.oscA.frequency.setTargetAtTime(f, t, 0.05);
    this.oscB.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.oscC.frequency.setTargetAtTime(f * 1.5, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(380 + 1500 * rpm + 300 * g, t, 0.06);
    const vol = alive ? (0.07 + 0.1 * sp) * (this.shiftDip > 0 ? 0.45 : 1) : 0;
    this.engineGain.gain.setTargetAtTime(vol, t, alive ? 0.04 : 0.3);
    this.windFilter.frequency.setTargetAtTime(400 + 2600 * sp, t, 0.2);
    this.windGain.gain.setTargetAtTime(alive ? 0.02 + 0.13 * sp * sp : 0.01, t, 0.25);
  }

  private burst(dur: number, type: BiquadFilterType, f0: number, f1: number, peak: number, q = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = this.now();
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, t);
    flt.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.04, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, peak: number, delay = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = this.now() + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** lane change: a short tyre chirp plus air */
  swerve() {
    this.burst(0.22, "bandpass", 2600, 1900, 0.16, 6);
    this.burst(0.25, "bandpass", 600, 2200, 0.2, 1.2);
  }

  /** a car going past close by */
  pass() {
    this.burst(0.45, "bandpass", 300, 1400, 0.3, 0.9);
  }

  jump() {
    this.burst(0.3, "bandpass", 500, 1800, 0.25, 1);
  }

  ramp() {
    this.tone("sine", 140, 60, 0.25, 0.4);
    this.burst(0.6, "bandpass", 400, 2400, 0.35, 0.8);
  }

  land() {
    this.tone("sine", 90, 40, 0.22, 0.6);
    this.burst(0.3, "lowpass", 1500, 200, 0.4);
  }

  /** wrong-way car: two-tone horn, twice */
  horn() {
    for (const d of [0, 0.32]) {
      this.tone("square", 392, 380, 0.24, 0.07, d);
      this.tone("square", 494, 480, 0.24, 0.06, d);
    }
  }

  crash() {
    this.tone("sine", 120, 30, 0.6, 1);
    this.burst(0.6, "lowpass", 3000, 200, 0.9);
    this.burst(1.6, "bandpass", 2400, 400, 0.4, 0.8);
    // long low rumble of the fireball
    this.burst(2.6, "lowpass", 700, 90, 0.55, 0.7);
    // metal: a few inharmonic partials ringing out
    for (const [f, a] of [[523, 0.08], [1187, 0.05], [1960, 0.04], [2730, 0.03]] as const) this.tone("triangle", f, f * 0.97, 1.1, a);
  }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem(MUTE_KEY, m ? "1" : "0"); } catch { /* private mode */ }
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.6, this.ctx.currentTime, 0.05);
  }

  dispose() {
    if (this.ctx instanceof AudioContext) void this.ctx.close();
    this.ctx = null;
  }
}

/** Calls the engine makes on RaceAudio, recorded with game time so a capture can be scored afterwards. */
export type AudioLog = [number, string, unknown[]][];
const LOGGED = new Set(["update", "swerve", "pass", "jump", "ramp", "land", "horn", "crash"]);

/** Wraps a RaceAudio so the listed calls are logged (at clock()) instead of played. */
export function recordingAudio(real: RaceAudio, log: AudioLog, clock: () => number): RaceAudio {
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
  const a = new RaceAudio();
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
