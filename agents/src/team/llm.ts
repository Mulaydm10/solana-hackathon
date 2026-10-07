/**
 * The model as a broker provider (PLAN §11): agents ask for `llm:complete` like any other capability, and the
 * broker makes the call with the sealed API key. So the key lives only in the broker's vault (the mission
 * service's environment); workers, events, logs and results never see it, and the broker's leak check
 * withholds any answer that echoes it.
 *
 * What the model may do is bounded here, in code: one prompt in, plain text out, sizes capped. Its text is
 * data for the worker, never an instruction to the orchestrator: anything a worker forwards still goes through
 * the quarantined reader, and amounts, payees and caps are decided in code against the on-chain mandate.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Provider } from "../broker/broker.ts";

export const LLM_MODEL = "claude-opus-5-5";

/** What a worker may send with `llm:complete`. */
export type CompleteArgs = { system: string; prompt: string };

import { LLM_LIMITS } from "./limits.ts";
export { LLM_LIMITS };

export type LlmProviderOptions = {
  model?: string;
  /** Injected in tests (offline); defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Milliseconds per request. Default 120 s. */
  timeoutMs?: number;
};

function parseArgs(args: unknown): CompleteArgs {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.system !== "string" || typeof a.prompt !== "string") throw new Error("BAD_ARGS: send { system, prompt } as strings");
  if (a.system.length > LLM_LIMITS.system || a.prompt.length > LLM_LIMITS.prompt) throw new Error("TOO_LONG: system or prompt over the limit");
  return { system: a.system, prompt: a.prompt };
}

export function claudeProvider(o: LlmProviderOptions = {}): Provider {
  const model = o.model ?? LLM_MODEL;
  return {
    id: "llm",
    hosts: ["api.anthropic.com:443"],
    async call(action, _resource, args, credential) {
      if (action !== "complete") throw new Error(`unknown action ${action}`);
      if (!credential) throw new Error("no credential");
      const { system, prompt } = parseArgs(args);
      // A client per call: the key is only in this closure for as long as the request runs.
      // Pinned: an ANTHROPIC_BASE_URL or ANTHROPIC_AUTH_TOKEN in the environment must not redirect or add credentials.
      const client = new Anthropic({ apiKey: credential, authToken: null, baseURL: "https://api.anthropic.com", fetch: o.fetch, timeout: o.timeoutMs ?? 120_000, maxRetries: 2 });
      const res = await client.beta.messages.create({
        model,
        max_tokens: LLM_LIMITS.maxTokens,
        system,
        messages: [{ role: "user", content: prompt }],
        output_config: { effort: "medium" },
        // A safety decline is rerouted by the API instead of ending the mission's stage with nothing.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      } as never);
      const msg = res as unknown as { stop_reason?: string; content?: { type: string; text?: string }[] };
      if (msg.stop_reason === "refusal") throw new Error("REFUSED: the model declined this request");
      const text = (msg.content ?? []).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
      if (!text) throw new Error("EMPTY: the model returned no text");
      return { text: text.slice(0, LLM_LIMITS.output), model };
    },
  };
}
