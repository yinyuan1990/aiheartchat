import { CSSProperties, useEffect, useRef, useState } from 'react';
import type { AnimationItem, LottiePlayer } from 'lottie-web';
import { StickerPayload } from '../stickers';

/** lottie 播放器按需加载（~150KB），没有动态贴纸的用户不用下 */
let lottieLib: Promise<LottiePlayer> | null = null;
function getLottie(): Promise<LottiePlayer> {
  if (!lottieLib) lottieLib = import('lottie-web/build/player/lottie_light').then((m) => (m.default ?? m) as LottiePlayer);
  return lottieLib;
}

const lottieCache = new Map<string, Promise<any>>();
function fetchLottie(url: string) {
  let p = lottieCache.get(url);
  if (!p) {
    p = fetch(url).then((r) => r.json());
    lottieCache.set(url, p);
    p.catch(() => lottieCache.delete(url));
  }
  return p;
}

/**
 * 渲染一张贴纸：静态/动态 WebP 直接 <img>；Lottie 只在进入视口时播放（列表里几十个同时跑会卡）。
 * size 为长边像素，按 w/h 保持比例。
 */
export function StickerView({ p, size = 140, autoplay = true, style, onClick }: { p: StickerPayload; size?: number; autoplay?: boolean; style?: CSSProperties; onClick?: () => void }) {
  const ratio = p.w && p.h ? p.w / p.h : 1;
  const w = ratio >= 1 ? size : Math.round(size * ratio);
  const h = ratio >= 1 ? Math.round(size / ratio) : size;
  const box: CSSProperties = { width: w, height: h, display: 'block', objectFit: 'contain', ...style };
  if (p.format === 'lottie') return <LottieSticker p={p} style={box} autoplay={autoplay} onClick={onClick} />;
  return <img src={p.url} alt={p.emoji} style={box} onClick={onClick} loading="lazy" draggable={false} />;
}

function LottieSticker({ p, style, autoplay, onClick }: { p: StickerPayload; style: CSSProperties; autoplay: boolean; onClick?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const animRef = useRef<AnimationItem>();
  const visibleRef = useRef(false);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !autoplay) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver((es) => setVisible(es.some((e) => e.isIntersecting)), { rootMargin: '80px' });
    io.observe(el);
    return () => io.disconnect();
  }, [autoplay]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let dead = false;
    Promise.all([getLottie(), fetchLottie(p.url)])
      .then(([lottie, data]) => {
        if (dead) return;
        const play = autoplay && visibleRef.current;
        const anim = lottie.loadAnimation({ container: el, renderer: 'svg', loop: true, autoplay: play, animationData: data, rendererSettings: { progressiveLoad: true } });
        if (!play) anim.goToAndStop(0, true);
        animRef.current = anim;
        setLoaded(true);
      })
      .catch(() => setFailed(true));
    return () => { dead = true; animRef.current?.destroy(); animRef.current = undefined; setLoaded(false); };
  }, [p.url]);

  // 视口进出：只暂停/继续，不重建
  useEffect(() => {
    visibleRef.current = visible;
    const anim = animRef.current;
    if (!anim) return;
    if (visible && autoplay) anim.play(); else anim.pause();
  }, [visible, autoplay]);

  if (failed && p.thumb) return <img src={p.thumb} alt={p.emoji} style={style} onClick={onClick} draggable={false} />;
  // JSON 下载完成前先垫静态缩略图，面板一屏几十个不至于一片空白
  const placeholder = !loaded && p.thumb ? { backgroundImage: `url(${p.thumb})`, backgroundSize: 'contain', backgroundRepeat: 'no-repeat', backgroundPosition: 'center' } : {};
  return <div ref={ref} style={{ ...style, ...placeholder }} onClick={onClick} />;
}

/** 面板网格里的小图：和 Telegram 一样动态的也直接播（Lottie 只在进入视口时跑） */
export function StickerThumb({ p, size = 56, onClick }: { p: StickerPayload; size?: number; onClick?: () => void }) {
  return <StickerView p={p} size={size} onClick={onClick} />;
}
