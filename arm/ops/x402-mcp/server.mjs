#!/usr/bin/env node
/**
 * 心之音 Web3「AI 模型」for Cursor (MCP, stdio, text only): BlockRun's chat models paid per call in USDC on Base over
 * x402 with your own wallet, through the Arm relay (see lib.mjs). The default model and the caps come from the local
 * picker UI (ui.mjs / 打开模型选择.bat). Every answer reports the model BlockRun says served it, tokens, cost and tx.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { account, balance, chat, config, footer, keyFile, ledger, models, usd } from "./lib.mjs";

const server = new McpServer({ name: "heartchat-x402", version: "0.2.0" });
const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

server.tool(
  "list_models",
  "List the BlockRun chat models available through 心之音 (HeartChat) x402: id, USD price per 1M input/output tokens, context window, and which one is the current default. Use the id with `chat`.",
  { search: z.string().optional().describe("filter by id / name / owner, e.g. 'claude', 'deepseek', 'free'") },
  async ({ search }) => {
    try {
      let list = await models();
      if (search) {
        const s = search.toLowerCase();
        list = list.filter((m) => (s === "free" ? m.free : `${m.id} ${m.name} ${m.owner}`.toLowerCase().includes(s)));
      }
      const def = config().defaultModel;
      const rows = list.map((m) => `${m.id}${m.id === def ? " (default)" : ""} | ${m.free ? "free" : `$${m.input}/$${m.output} per 1M`} | ctx ${m.context ?? "?"}${m.reasoning ? " | reasoning" : ""}`);
      return ok(`${rows.length} models, default ${def} (paid per call in USDC on Base; the quote assumes the full max_tokens reply):\n${rows.join("\n")}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "chat",
  "Ask a BlockRun model (GPT, Claude, Gemini, DeepSeek, Qwen, Kimi, Grok, GLM…) a question, paid per call from the configured wallet in USDC on Base. Leave `model` empty to use the default chosen in the HeartChat model picker. Returns the answer plus the model BlockRun reports as having served it, token usage, cost and the payment tx.",
  {
    prompt: z.string().describe("the user message"),
    model: z.string().optional().describe("model id from list_models; empty = the default from the picker"),
    system: z.string().optional().describe("optional system prompt"),
    max_tokens: z.number().int().min(1).max(4096).optional().describe("reply length cap (default 1024); the price is quoted on this, so smaller is cheaper"),
  },
  async ({ model, prompt, system, max_tokens }) => {
    try {
      const messages = [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }];
      const r = await chat(model, messages, max_tokens ?? 1024);
      return ok(`${r.text}\n\n${footer(r)}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "compare",
  "Send the same prompt to 2-4 BlockRun models in parallel and return each answer with the model that actually served it, tokens and cost. Useful to check whether a model is what it claims to be.",
  {
    models: z.array(z.string()).min(2).max(4).describe("model ids from list_models"),
    prompt: z.string(),
    max_tokens: z.number().int().min(1).max(4096).optional().describe("default 600"),
  },
  async ({ models: ids, prompt, max_tokens }) => {
    const out = await Promise.all(ids.map(async (m) => {
      try {
        const r = await chat(m, [{ role: "user", content: prompt }], max_tokens ?? 600);
        return `### ${m}\n${r.text}\n\n${footer(r)}`;
      } catch (e) {
        return `### ${m}\nError: ${e instanceof Error ? e.message : String(e)}`;
      }
    }));
    return ok(out.join("\n\n"));
  },
);

server.tool("wallet", "Show the paying wallet: address, USDC balance on Base, today's spend, the caps and the default model.", {}, async () => {
  try {
    if (!account) return ok(`No wallet key configured (X402_PRIVATE_KEY or X402_KEY_FILE; looked at ${keyFile}). Free models still work.`);
    const bal = await balance();
    const l = ledger(), c = config();
    return ok(`address ${account.address} (Base)\nUSDC ${usd(bal)}\ntoday ${usd(l.spent)} over ${l.calls} paid calls\ncaps: ${usd(c.maxPerCall * 1e6)} per call, ${usd(c.dailyCap * 1e6)} per day\ndefault model ${c.defaultModel}\nTop up: send USDC on Base to the address above.`);
  } catch (e) {
    return fail(e);
  }
});

await server.connect(new StdioServerTransport());
