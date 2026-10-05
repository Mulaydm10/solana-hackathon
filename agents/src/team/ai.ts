/**
 * Which text source the workers' `llm:complete` capability uses (#183, #191), chosen once from the environment:
 *   AI_PROVIDER=simulated  -> the labelled Simulated AI demo (no key, no network);
 *   AI_PROVIDER=anthropic  -> Claude; needs ANTHROPIC_API_KEY;
 *   unset                  -> Claude if ANTHROPIC_API_KEY is set, else none (workers' deterministic output).
 * Both providers sit behind the same broker interface, so the safety architecture does not change with the choice.
 */
import type { Provider } from "../broker/broker.ts";
import { claudeProvider, LLM_MODEL } from "./llm.ts";
import { SIMULATED_LABEL, simulatedProvider } from "./simulated.ts";

export type AiChoice =
  | { mode: "simulated" | "anthropic"; provider: Provider; credential: string; label: string }
  | { mode: "none"; provider: null; credential: null; label: string };

export function aiProviderFrom(env: Record<string, string | undefined>): { ok: true; value: AiChoice } | { ok: false; message: string } {
  const want = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (want === "simulated") {
    // The broker hands every provider a sealed credential; the simulation needs none, so it gets a placeholder.
    return { ok: true, value: { mode: "simulated", provider: simulatedProvider(), credential: "simulated-no-key", label: `${SIMULATED_LABEL} (no live model)` } };
  }
  if (want !== "" && want !== "anthropic") return { ok: false, message: `AI_PROVIDER must be "simulated" or "anthropic", not "${env.AI_PROVIDER}"` };
  const key = env.ANTHROPIC_API_KEY;
  if (!key) {
    if (want === "anthropic") return { ok: false, message: "AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY" };
    return { ok: true, value: { mode: "none", provider: null, credential: null, label: "deterministic workers (no AI; set AI_PROVIDER=simulated or ANTHROPIC_API_KEY)" } };
  }
  const model = env.LLM_MODEL ?? LLM_MODEL;
  return { ok: true, value: { mode: "anthropic", provider: claudeProvider({ model }), credential: key, label: `Claude (${model}) through the broker` } };
}
