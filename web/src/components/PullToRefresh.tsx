import { ReactNode, useEffect, useRef } from 'react';

const THRESHOLD = 56;
const MAX_PULL = 110;

/**
 * 下拉刷新：包在可滚动容器（最近的 .page）内的内容外层。
 * 只有滚动条在顶部时才响应下拉；拉过阈值松手触发 onRefresh。
 * 拖动过程直接改 DOM（不走 setState），避免带动整个列表重渲染。
 */
export function PullToRefresh({ onRefresh, children }: { onRefresh: () => Promise<unknown> | void; children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const refreshFn = useRef(onRefresh);
  refreshFn.current = onRefresh;

  useEffect(() => {
    const root = rootRef.current;
    const bar = barRef.current;
    if (!root || !bar) return;
    // 手势挂在滚动容器上：内容不足一屏时，空白区域下拉也能刷新
    const scroller = (root.closest('.page') as HTMLElement | null) ?? root;
    const scrollTop = () => scroller.scrollTop;

    let startY = 0;
    let pulling = false;
    let dist = 0;
    let refreshing = false;

    const setBar = (h: number, text: string, animate: boolean) => {
      bar.style.transition = animate ? 'height .2s' : 'none';
      bar.style.height = `${h}px`;
      bar.textContent = text;
    };

    const onStart = (e: TouchEvent) => {
      if (refreshing || scrollTop() > 0) return;
      startY = e.touches[0].clientY;
      pulling = true;
      dist = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || scrollTop() > 0) {
        // 往上滑或列表已经滚动：放弃这次下拉，让容器正常滚动
        if (dist === 0) pulling = false;
        return;
      }
      // 阻止 WebView 自己的回弹/过度滚动效果
      if (e.cancelable) e.preventDefault();
      dist = Math.min(MAX_PULL, dy * 0.55);
      setBar(dist, dist >= THRESHOLD ? '松开刷新' : '下拉刷新', false);
    };
    const onEnd = async () => {
      if (!pulling) return;
      pulling = false;
      if (dist < THRESHOLD) {
        setBar(0, '', true);
        return;
      }
      refreshing = true;
      setBar(THRESHOLD, '刷新中…', true);
      try {
        await refreshFn.current();
      } finally {
        refreshing = false;
        setBar(0, '', true);
      }
    };

    scroller.addEventListener('touchstart', onStart, { passive: true });
    scroller.addEventListener('touchmove', onMove, { passive: false });
    scroller.addEventListener('touchend', onEnd);
    scroller.addEventListener('touchcancel', onEnd);
    return () => {
      scroller.removeEventListener('touchstart', onStart);
      scroller.removeEventListener('touchmove', onMove);
      scroller.removeEventListener('touchend', onEnd);
      scroller.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  return (
    <div ref={rootRef}>
      <div
        ref={barRef}
        className="small"
        style={{ height: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      />
      {children}
    </div>
  );
}
