import Anthropic from "@anthropic-ai/sdk";
import { SERVICES } from "./catalog.ts";
import { createApp } from "./app.ts";
import { createDesk } from "./desk.ts";
import { claudeDrafter, ruleDraft, withFallback } from "./draft.ts";
import { claudeProducer, placeholderProducer } from "./deliver.ts";
import { readConfig } from "./keys.ts";

const cfg = readConfig();
const desk = await createDesk(cfg);
const claude = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const app = createApp({
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
app.listen(port, () => {
  console.log(`procurement layer demo on http://localhost:${port}  (buyer ${desk.buyer}, AI drafting: ${claude ? "Claude" : "rules"})`);
});
