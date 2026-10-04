// The seller side of the demo: a seller agent produces the deliverable. With a Claude key the
// work is real; without one a placeholder stands in. Only its sha256 goes on chain.
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { Service } from "./catalog.ts";

export type Producer = (service: Service, task: string) => Promise<string>;

export const placeholderProducer: Producer = async (service, task) =>
  `[${service.name}] Delivery for: ${task}\n\n(Demo placeholder - set ANTHROPIC_API_KEY for a real deliverable.)`;

export function claudeProducer(client: Anthropic, model = "claude-opus-5-5"): Producer {
  return async (service, task) => {
    const response = await client.messages.create({
      model,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system: `You are ${service.name}, a service that ${service.description.toLowerCase()}. Produce the deliverable for the task. Keep it under 300 words. Output only the deliverable.`,
      messages: [{ role: "user", content: `<task>${task}</task>` }],
    });
    if (response.stop_reason === "refusal") throw new Error("seller declined the task");
    return response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
  };
}

export function sha256(text: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(text).digest());
}
