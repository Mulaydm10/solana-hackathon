/** The model call's size limits, shared by the Claude provider (llm.ts) and the Simulated AI demo (simulated.ts) so
 * both refuse at exactly the same sizes. Its own file so the simulated provider never loads the model SDK. */
export const LLM_LIMITS = { system: 4_000, prompt: 12_000, maxTokens: 8_000, output: 4_000 } as const;
