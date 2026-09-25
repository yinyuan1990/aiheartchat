/** DeepSeek（OpenAI 兼容）JSON 模式调用，返回 message.content 原文 */
export async function callModel(messages: { role: string; content: string }[], temperature?: number, maxTokens = 1200): Promise<string> {
  const base = (process.env.AI_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/$/, '');
  const model = process.env.AI_MODEL ?? 'deepseek-chat';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AI_API_KEY}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, ...(temperature != null ? { temperature } : {}), response_format: { type: 'json_object' } }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`上游 ${res.status}`);
    const data: any = await res.json();
    return data?.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}
