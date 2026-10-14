/**
 * 10.14: Claude through BlockRun's OpenAI-style /chat/completions buffers every tool-call argument until it is complete
 * (a whole file in `contents` = minutes of silence, then BlockRun cuts it at 120 s). On the Anthropic-native
 * /v1/messages, `eager_input_streaming: true` on each tool streams the arguments as they are written; BlockRun drops that
 * flag on /chat/completions. So Cursor's OpenAI request is rewritten for /v1/messages here, and the Anthropic SSE is
 * turned back into OpenAI chunks, so the rest of ai-proxy (dedup, keepalive, usage log) sees what it always saw.
 */

type Part = { type?: string; text?: string; image_url?: { url?: string } | string };
type OaiMsg = { role?: string; content?: unknown; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]; tool_call_id?: string };
type Block = Record<string, unknown> & { type: string };
type AMsg = { role: "user" | "assistant"; content: Block[] };

/** Anthropic only takes [A-Za-z0-9_-] ids; history may carry ids minted by other converters */
const tid = (id: unknown) => String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "_") || "tool";

function image(p: Part): Block | null {
  const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
  if (!url) return null;
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } } : { type: "image", source: { type: "url", url } };
}

function blocks(content: unknown): Block[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return content == null ? [] : [{ type: "text", text: JSON.stringify(content) }];
  const out: Block[] = [];
  for (const p of content as Part[]) {
    if (p?.type === "image_url") {
      const b = image(p);
      if (b) out.push(b);
    } else {
      const text = typeof p?.text === "string" ? p.text : JSON.stringify(p);
      if (text) out.push({ type: "text", text });
    }
  }
  return out;
}

const textOf = (content: unknown) => blocks(content).filter((b) => b.type === "text").map((b) => b.text as string).join("\n\n");

/** OpenAI chat body → Anthropic /v1/messages body (streaming, eager tool input) */
export function toMessages(body: Record<string, unknown>): Record<string, unknown> {
  const system: Block[] = [];
  const msgs: AMsg[] = [];
  const push = (role: AMsg["role"], content: Block[]) => {
    const last = msgs[msgs.length - 1];
    if (last?.role === role) last.content.push(...content);
    else msgs.push({ role, content });
  };
  for (const m of (Array.isArray(body.messages) ? body.messages : []) as OaiMsg[]) {
    if (m.role === "system" || m.role === "developer") {
      const t = textOf(m.content);
      if (t) system.push({ type: "text", text: t });
    } else if (m.role === "assistant") {
      const c: Block[] = blocks(m.content).filter((b) => b.type === "text");
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          input = { _unparsed_arguments: tc.function?.arguments ?? "" };
        }
        c.push({ type: "tool_use", id: tid(tc.id), name: tc.function?.name ?? "tool", input: input && typeof input === "object" ? input : { value: input } });
      }
      if (c.length) push("assistant", c);
    } else if (m.role === "tool") {
      const c = blocks(m.content);
      push("user", [{ type: "tool_result", tool_use_id: tid(m.tool_call_id), content: c.length ? c : "(empty)" }]);
    } else {
      const c = blocks(m.content);
      push("user", c.length ? c : [{ type: "text", text: "(empty)" }]);
    }
  }
  // Anthropic rejects: a first turn that isn't the user's, tool_use without a tool_result right after it, and
  // tool_result whose tool_use isn't in the turn just before (e.g. a cancelled tool call in Cursor's history)
  if (msgs[0]?.role !== "user") msgs.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    const prev = msgs[i - 1];
    const asked = new Set(prev?.role === "assistant" ? prev.content.filter((b) => b.type === "tool_use").map((b) => b.id as string) : []);
    const answered = new Set<string>();
    m.content = m.content.map((b) => {
      if (b.type !== "tool_result") return b;
      if (asked.has(b.tool_use_id as string) && !answered.has(b.tool_use_id as string)) {
        answered.add(b.tool_use_id as string);
        return b;
      }
      const c = b.content;
      return { type: "text", text: `[tool result ${b.tool_use_id}]\n${typeof c === "string" ? c : textOf(c)}` };
    });
    const missing = [...asked].filter((id) => !answered.has(id)).map((id): Block => ({ type: "tool_result", tool_use_id: id, content: "(no result: the tool call was not run)", is_error: true }));
    // tool results must come first in the user turn
    m.content = [...missing, ...m.content.filter((b) => b.type === "tool_result"), ...m.content.filter((b) => b.type !== "tool_result")];
  }
  const last = msgs[msgs.length - 1];
  if (last?.role === "assistant" && last.content.some((b) => b.type === "tool_use"))
    msgs.push({ role: "user", content: last.content.filter((b) => b.type === "tool_use").map((b): Block => ({ type: "tool_result", tool_use_id: b.id as string, content: "(no result: the tool call was not run)", is_error: true })) });

  const out: Record<string, unknown> = { model: body.model, max_tokens: Number(body.max_tokens ?? body.max_completion_tokens ?? 0) || 16384, stream: true, messages: msgs };
  if (system.length) out.system = system;
  const tools = Array.isArray(body.tools) ? (body.tools as { type?: string; function?: { name?: string; description?: string; parameters?: unknown } }[]) : [];
  if (tools.length)
    out.tools = tools.filter((t) => t.function?.name).map((t) => ({ name: t.function!.name, description: t.function!.description ?? "", input_schema: t.function!.parameters ?? { type: "object", properties: {} }, eager_input_streaming: true }));
  const tc = body.tool_choice as string | { type?: string; function?: { name?: string } } | undefined;
  let choice: Record<string, unknown> | undefined =
    tc === "required" ? { type: "any" } : tc === "none" ? { type: "none" } : tc === "auto" ? { type: "auto" } : typeof tc === "object" && tc?.function?.name ? { type: "tool", name: tc.function.name } : undefined;
  if (body.parallel_tool_calls === false && out.tools) choice = { ...(choice ?? { type: "auto" }), disable_parallel_tool_use: true };
  if (choice && out.tools) out.tool_choice = choice;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  else if (typeof body.top_p === "number") out.top_p = body.top_p;
  const stop = body.stop;
  if (typeof stop === "string" || Array.isArray(stop)) out.stop_sequences = ([] as string[]).concat(stop as string | string[]).filter(Boolean);
  return out;
}

const FINISH: Record<string, string> = { end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", max_tokens: "length", pause_turn: "stop", refusal: "content_filter" };

/** Anthropic SSE → OpenAI chat.completion.chunk SSE (ends with a usage chunk and [DONE], like OpenAI with include_usage) */
export function fromMessagesStream(): TransformStream<Uint8Array, Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const created = Math.floor(Date.now() / 1000);
  let buf = "", id = "chatcmpl-claude", model = "claude", tools = 0, finish: string | null = null, ended = false;
  const kinds = new Map<number, { kind: string; tool?: number }>();
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const chunk = (delta: object, finish_reason: string | null = null, m = model) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: m, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const end = () => {
    if (ended) return "";
    ended = true;
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    return (
      chunk({}, finish ?? "stop") +
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: { prompt_tokens: prompt, completion_tokens: usage.output, total_tokens: prompt + usage.output, prompt_tokens_details: { cached_tokens: usage.cacheRead } } })}\n\n` +
      "data: [DONE]\n\n"
    );
  };
  const onEvent = (e: Record<string, any>): string => {
    switch (e.type) {
      case "message_start": {
        const m = e.message ?? {};
        if (m.id) id = m.id;
        if (m.model) model = m.model;
        usage.input = m.usage?.input_tokens ?? 0;
        usage.cacheRead = m.usage?.cache_read_input_tokens ?? 0;
        usage.cacheWrite = m.usage?.cache_creation_input_tokens ?? 0;
        usage.output = m.usage?.output_tokens ?? 0;
        return chunk({ role: "assistant", content: "" });
      }
      case "content_block_start": {
        const b = e.content_block ?? {};
        if (b.type === "tool_use") {
          const t = tools++;
          kinds.set(e.index, { kind: "tool", tool: t });
          return chunk({ tool_calls: [{ index: t, id: b.id, type: "function", function: { name: b.name, arguments: "" } }] });
        }
        kinds.set(e.index, { kind: b.type });
        return b.type === "text" && b.text ? chunk({ content: b.text }) : "";
      }
      case "content_block_delta": {
        const d = e.delta ?? {};
        if (d.type === "text_delta") return d.text ? chunk({ content: d.text }) : "";
        if (d.type === "input_json_delta") {
          const k = kinds.get(e.index);
          return d.partial_json && k?.tool !== undefined ? chunk({ tool_calls: [{ index: k.tool, function: { arguments: d.partial_json } }] }) : "";
        }
        if (d.type === "thinking_delta") return d.thinking ? chunk({ reasoning_content: d.thinking }) : "";
        return "";
      }
      case "message_delta":
        if (e.delta?.stop_reason) finish = FINISH[e.delta.stop_reason] ?? "stop";
        if (e.usage?.output_tokens != null) usage.output = e.usage.output_tokens;
        if (e.usage?.input_tokens) usage.input = e.usage.input_tokens;
        return "";
      case "message_stop":
        return end();
      case "error":
        // model "error" is what ai-proxy's failure detection looks for
        return chunk({ content: `[Error: ${e.error?.message ?? "upstream error"} (${e.error?.type ?? "error"})]` }, null, "error");
      case "ping":
        return ": ping\n\n";
      default:
        return "";
    }
  };
  const lines = (ctl: TransformStreamDefaultController<Uint8Array>, flush: boolean) => {
    let i: number;
    let out = "";
    while ((i = buf.indexOf("\n")) >= 0 || (flush && buf)) {
      const line = (i >= 0 ? buf.slice(0, i) : buf).trim();
      buf = i >= 0 ? buf.slice(i + 1) : "";
      if (!line.startsWith("data:")) continue;
      try {
        out += onEvent(JSON.parse(line.slice(5)));
      } catch {}
    }
    if (out) ctl.enqueue(enc.encode(out));
  };
  return new TransformStream({
    transform(c, ctl) {
      buf += dec.decode(c, { stream: true });
      lines(ctl, false);
    },
    flush(ctl) {
      buf += dec.decode();
      lines(ctl, true);
      // the upstream broke off before message_stop: say so (counts as a failed answer) and close the OpenAI stream
      if (!ended) ctl.enqueue(enc.encode(chunk({ content: "[Error: upstream stream ended before message_stop]" }, null, "error") + end()));
    },
  });
}

/** Anthropic error JSON → OpenAI-style error JSON */
export function oaiError(text: string) {
  try {
    const j = JSON.parse(text) as { error?: { message?: string; type?: string } | string; message?: string };
    const e = typeof j.error === "object" ? j.error : { message: j.message ?? String(j.error ?? text), type: "upstream_error" };
    return JSON.stringify({ error: { message: e?.message ?? text, type: e?.type ?? "upstream_error" } });
  } catch {
    return JSON.stringify({ error: { message: text.slice(0, 2000), type: "upstream_error" } });
  }
}
