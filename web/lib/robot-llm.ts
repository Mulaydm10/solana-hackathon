// Claude as the robot's charging planner (#255). Server-only: wraps the Anthropic API.
// The key is never logged or returned in an error message.

export type LlmFn = (system: string, prompt: string) => Promise<string>;

/**
 * Calls the Claude API directly. Never logs or returns the API key.
 * Throws on non-2xx responses or if the model does not return a text block.
 */
export function anthropicLlm(apiKey: string, fetchFn: typeof fetch = fetch): LlmFn {
  return async (system: string, prompt: string): Promise<string> => {
    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      content?: { type: string; text?: string }[];
    };
    const text = data.content?.find((c) => c.type === "text")?.text;
    if (typeof text !== "string") {
      throw new Error("No text block in Anthropic response");
    }
    return text;
  };
}
