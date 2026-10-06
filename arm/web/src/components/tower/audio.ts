// The original tower_game sounds (public/tower/*.mp3), played through Web Audio so mute and the capture log work like
// the other games. The AudioContext can only start inside a user gesture, so unlock() is called from start / input.

const MUTE_KEY = "arm-tower-muted";
const SOUNDS = ["drop", "drop-perfect", "rotate", "game-over", "bgm"] as const;
export type Sound = (typeof SOUNDS)[number];
const VOLUME: Record<Sound, number> = { drop: 1, "drop-perfect": 1, rotate: 0.8, "game-over": 1, bgm: 0.45 };

async function loadAll(ctx: BaseAudioContext) {
  const out: Partial<Record<Sound, AudioBuffer>> = {};
  await Promise.all(SOUNDS.map(async (s) => {
    try {
      const bytes = await (await fetch(`/tower/${s}.mp3`)).arrayBuffer();
      out[s] = await ctx.decodeAudioData(bytes);
    } catch { /* a missing sound just stays silent */ }
  }));
  return out;
}

export class TowerAudio {
  private ctx: BaseAudioContext | null = null;
  /** offline rendering sets this so every call schedules at a given time instead of "now" */
  clock: number | null = null;
  private now() { return this.clock ?? this.ctx!.currentTime; }
  private master!: GainNode;
  buffers: Partial<Record<Sound, AudioBuffer>> = {};
  private bgmSrc: AudioBufferSourceNode | null = null;
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
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(ctx.destination);
    if (!given) void loadAll(ctx).then((b) => { this.buffers = b; });
  }

  private play(s: Sound, loop = false) {
    const buf = this.buffers[s];
    if (!this.ctx || !buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    const g = this.ctx.createGain();
    g.gain.value = VOLUME[s];
    src.connect(g).connect(this.master);
    src.start(this.now());
    return src;
  }

  drop(perfect: boolean) { this.play(perfect ? "drop-perfect" : "drop"); }
  rotate() { this.play("rotate"); }
  over() { this.bgmStop(); this.play("game-over"); }
  bgm() {
    this.bgmStop();
    this.bgmSrc = this.play("bgm", true);
  }
  bgmStop() {
    if (!this.bgmSrc) return;
    try { this.bgmSrc.stop(this.now()); } catch { /* already stopped */ }
    this.bgmSrc = null;
  }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem(MUTE_KEY, m ? "1" : "0"); } catch { /* private mode */ }
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.03);
  }

  dispose() {
    this.bgmStop();
    if (this.ctx instanceof AudioContext) void this.ctx.close();
    this.ctx = null;
  }
}

/** Calls the engine makes on TowerAudio, recorded with game time so a capture can be scored afterwards. */
export type AudioLog = [number, string, unknown[]][];
const LOGGED = new Set(["drop", "rotate", "over", "bgm", "bgmStop"]);

/** Wraps a TowerAudio so the listed calls are logged (at clock()) instead of played. */
export function recordingAudio(real: TowerAudio, log: AudioLog, clock: () => number): TowerAudio {
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
  const a = new TowerAudio();
  a.muted = false;
  a.unlock(ctx);
  a.buffers = await loadAll(ctx);
  const api = a as unknown as Record<string, (...x: unknown[]) => void>;
  // a loop that started before t0 is still playing at t0
  const bgmOn = log.filter(([t, n]) => t < t0 && (n === "bgm" || n === "bgmStop" || n === "over")).pop()?.[1] === "bgm";
  if (bgmOn) { a.clock = 0; a.bgm(); }
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
