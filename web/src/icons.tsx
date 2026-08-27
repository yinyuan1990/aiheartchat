// 统一矢量线性图标（不使用 emoji）
const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const IconPlaza = () => (
  <svg viewBox="0 0 24 24" {...p}>
    <rect x="3" y="3" width="8" height="10" rx="2" />
    <rect x="13" y="3" width="8" height="6" rx="2" />
    <rect x="13" y="11" width="8" height="10" rx="2" />
    <rect x="3" y="15" width="8" height="6" rx="2" />
  </svg>
);

export const IconHall = () => (
  <svg viewBox="0 0 24 24" {...p}>
    <path d="M12 3l9 6v12H3V9l9-6z" />
    <path d="M9 21v-6h6v6" />
  </svg>
);

export const IconChat = () => (
  <svg viewBox="0 0 24 24" {...p}>
    <path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z" />
    <line x1="9" y1="10" x2="15" y2="10" />
    <line x1="9" y1="13" x2="13" y2="13" />
  </svg>
);

export const IconMe = () => (
  <svg viewBox="0 0 24 24" {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.5-6.5 8-6.5s8 2.5 8 6.5" />
  </svg>
);

export const IconGuide = () => (
  <svg viewBox="0 0 24 24" {...p} color="#d4af37">
    <path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z" />
    <circle cx="12" cy="10" r="2.5" />
  </svg>
);

export const IconTask = () => (
  <svg viewBox="0 0 24 24" {...p} color="#d4af37">
    <rect x="4" y="4" width="16" height="17" rx="2" />
    <line x1="8" y1="9" x2="16" y2="9" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="12" y2="17" />
  </svg>
);

export const IconUser = () => (
  <svg viewBox="0 0 24 24" {...p} color="#d4af37" width="32" height="32">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.5-6.5 8-6.5s8 2.5 8 6.5" />
  </svg>
);
