import Anthropic from "@anthropic-ai/sdk";
import { SERVICES } from "./catalog.ts";
import { createApp } from "./app.ts";
import { createDesk } from "./desk.ts";
import { claudeDrafter, ruleDraft, withFallback } from "./draft.ts";
import { claudeProducer, placeholderProducer } from "./deliver.ts";
import { loadOrCreateToken, readConfig } from "./keys.ts";

const cfg = readConfig();
const desk = await createDesk(cfg);
const claude = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const token = loadOrCreateToken();
const app = createApp({
  guard: { token },
  desk,
  draft: withFallback(claude && claudeDrafter(claude), ruleDraft),
  produce: claude
    ? async (s, t) => claudeProducer(claude)(s, t).catch(() => placeholderProducer(s, t))
    : placeholderProducer,
  services: SERVICES,
  decimals: cfg.decimals,
  symbol: cfg.symbol,
  defaultBudgetUsdc: 50,
  drafting: claude ? "claude" : "rules",
  cluster: process.env.CLUSTER ?? (cfg.rpcUrl.includes("devnet") ? "devnet" : "localnet"),
});
const port = Number(process.env.PORT ?? 3000);
// Loopback by default. To serve a private network (e.g. Tailscale) set HOST to that interface's
// address; never 0.0.0.0 on a shared network.
const host = process.env.HOST ?? "127.0.0.1";
app.listen(port, host, () => {
  console.log(`procurement layer demo on http://${host}:${port}  (buyer ${desk.buyer}, AI drafting: ${claude ? "Claude" : "rules"})`);
  console.log(`open with the write token once: http://${host}:${port}/?token=${token}`);
});
