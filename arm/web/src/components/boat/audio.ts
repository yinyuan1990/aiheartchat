// Synthesized sound (Web Audio, no files): outboard engine hum, water rush, lane-change whoosh, crash.
// The AudioContext can only start inside a user gesture, so unlock() is called from start / steer input.

const MUTE_KEY = "arm-boat-muted";

export class BoatAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private oscA!: OscillatorNode;
  private oscB!: OscillatorNode;
  private lfo!: OscillatorNode;
  private waterGain!: GainNode;
  private waterFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
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
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // engine: two detuned saws through a resonant low-pass, chugging via an LFO on the gain
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.Q.value = 3;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    const chug = ctx.createGain();
    chug.gain.value = 0.75;
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 18;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.25;
    this.lfo.connect(lfoDepth).connect(chug.gain);
    this.oscA = ctx.createOscillator();
    this.oscA.type = "sawtooth";
    this.oscB = ctx.createOscillator();
    this.oscB.type = "square";
    this.oscB.detune.value = 12;
    const bGain = ctx.createGain();
    bGain.gain.value = 0.4;
    this.oscA.connect(this.engineFilter);
    this.oscB.connect(bGain).connect(this.engineFilter);
    this.engineFilter.connect(chug).connect(this.engineGain).connect(this.master);
    this.oscA.start();
    this.oscB.start();
    this.lfo.start();

    // water rush: looped noise through a band-pass that opens with speed
    const water = ctx.createBufferSource();
    water.buffer = this.noise;
    water.loop = true;
    this.waterFilter = ctx.createBiquadFilter();
    this.waterFilter.type = "bandpass";
    this.waterFilter.Q.value = 0.6;
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0;
    water.connect(this.waterFilter).connect(this.waterGain).connect(this.master);
    water.start();
  }

  /** sp = speed / top speed (0..1); alive = engine running; air = prop out of the water (revs up). Called every frame. */
  update(sp: number, alive: boolean, air = false) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const f = (48 + 95 * sp) * (air ? 1.45 : 1);
    this.oscA.frequency.setTargetAtTime(f, t, 0.1);
    this.oscB.frequency.setTargetAtTime(f * 0.5, t, 0.1);
    this.lfo.frequency.setTargetAtTime(16 + 30 * sp, t, 0.1);
    this.engineFilter.frequency.setTargetAtTime(260 + 1100 * sp, t, 0.1);
    this.engineGain.gain.setTargetAtTime(alive ? 0.05 + 0.13 * sp : 0, t, alive ? 0.15 : 0.25);
    this.waterFilter.frequency.setTargetAtTime(500 + 1800 * sp, t, 0.15);
    this.waterGain.gain.setTargetAtTime(air ? 0.03 : 0.05 + 0.2 * sp, t, air ? 0.08 : 0.2);
  }

  splash() {
    this.burst(0.6, "lowpass", 1800, 250, 0.6);
    this.burst(0.9, "bandpass", 1400, 600, 0.3, 0.8);
  }

  private burst(dur: number, type: BiquadFilterType, f0: number, f1: number, peak: number, q = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
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

  whoosh() {
    this.burst(0.28, "bandpass", 700, 2600, 0.35, 1.2);
  }

  crash() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const thump = ctx.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(110, t);
    thump.frequency.exponentialRampToValueAtTime(35, t + 0.45);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    thump.connect(g).connect(this.master);
    thump.start(t);
    thump.stop(t + 0.55);
    this.burst(0.5, "lowpass", 2500, 200, 0.8);
    this.burst(1.4, "bandpass", 1800, 500, 0.45, 0.7);
  }

  /** Incoming shell: a sine whistle that falls in pitch and swells over `dur` seconds. */
  whistle(dur: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(1900, t);
    o.frequency.exponentialRampToValueAtTime(420, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + dur * 0.85);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Shell hitting the water: deep thump plus a long low rumble. */
  boom() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const thump = ctx.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(90, t);
    thump.frequency.exponentialRampToValueAtTime(24, t + 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1.0, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    thump.connect(g).connect(this.master);
    thump.start(t);
    thump.stop(t + 0.85);
    this.burst(0.9, "lowpass", 1600, 120, 0.9);
    this.burst(1.8, "bandpass", 900, 300, 0.4, 0.6);
  }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem(MUTE_KEY, m ? "1" : "0"); } catch { /* private mode */ }
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.05);
  }

  dispose() {
    void this.ctx?.close();
    this.ctx = null;
  }
}
