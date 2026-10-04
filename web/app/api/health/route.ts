import { DEAL_ESCROW_PROGRAM_ADDRESS } from "@deal/chain";
import { health, parseEnv } from "../../../lib/env";

export const dynamic = "force-dynamic";

export function GET() {
  const h = health(parseEnv(process.env));
  return Response.json({ ...h, program: DEAL_ESCROW_PROGRAM_ADDRESS }, { status: h.ok ? 200 : 500 });
}
