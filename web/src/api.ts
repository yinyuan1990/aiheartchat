// http 环境（非安全上下文）没有 crypto.randomUUID，做降级
function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// 设备 ID（Web 端用 localStorage UUID，一机一号 + 卸载恢复的 Web 等价实现）
export function getDeviceId(): string {
  let id = localStorage.getItem('pw_device_id');
  if (!id) {
    id = 'web_' + randomId();
    localStorage.setItem('pw_device_id', id);
  }
  return id;
}

export function getToken(): string | null {
  return localStorage.getItem('pw_token');
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem('pw_token', token);
  else localStorage.removeItem('pw_token');
}

export async function api<T = any>(path: string, options: { method?: string; body?: any } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await res.json();
  if (json.code !== 0) {
    if (json.code === 401) {
      setToken(null);
      location.hash = '#/enter';
    }
    throw new Error(json.msg || '请求失败');
  }
  return json.data as T;
}

/** 分 → 积分 显示（100 分 = 1 积分），去掉多余的 0 */
export function fmtPoints(fen: string | number | bigint | undefined | null): string {
  const n = Number(fen ?? 0) / 100;
  return n.toFixed(2).replace(/\.?0+$/, '') || '0';
}

/** 积分（可含小数）→ 分 */
export function toFen(points: string | number): number {
  return Math.round(Number(points || 0) * 100);
}

/** 登录后上传（image | video） */
export async function uploadFile(kind: 'image' | 'video', file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/upload/${kind}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form,
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(json.msg || '上传失败');
  return json.data.url as string;
}

export interface UserProfile {
  id: string;
  shortId?: string;
  address: string;
  nickname: string;
  avatar: string;
  gender: number;
  age: number;
  cityCode: string;
  cityName: string;
  signature: string;
  isGuide: boolean;
  videoPriceFen?: number;
  realname?: boolean;
  realNameMasked?: string;
  balance?: string;
  frozen?: string;
  following?: number;
  fans?: number;
  /** 照片墙（最多 8 张） */
  albums?: { id: string; type: number; url: string; coverUrl?: string; sort?: number }[];
}
