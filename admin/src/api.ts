export function getToken(): string | null {
  return localStorage.getItem('pw_admin_token');
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem('pw_admin_token', token);
  else localStorage.removeItem('pw_admin_token');
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
      location.reload();
    }
    throw new Error(json.msg || '请求失败');
  }
  return json.data as T;
}
