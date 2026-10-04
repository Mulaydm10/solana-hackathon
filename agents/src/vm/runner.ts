/**
 * Per-agent runner (PLAN §6.2, idea from Harness). Each agent runs isolated, with no credentials and,
 * where the platform allows it, no network at all: its only channel out is line-delimited JSON on
 * stdin/stdout, which the runner answers by calling the capability broker (`call`) or hands to the
 * orchestrator (`message`). So an injected instruction has nowhere to send data except through a
 * capability the buyer approved.
 *
 * Lifecycle, all against the chain:
 *   - start: refused unless the agent's mandate is live (so its secrets stay sealed);
 *   - while running: the mandate is polled; revoked or expired -> the process is killed;
 *   - a wall-clock limit kills it too.
 *
 * Modes:
 *   - "process": `node --permission` with no fs write, no child processes, no workers, no addons and,
 *     on Node versions that govern it, no network (`isolation` says which you got). Local dev fallback.
 *   - "container": Docker with a read-only root, no network, all capabilities dropped, non-root user,
 *     CPU/memory/pid limits (`containerArgs`). Needs Docker (colima on the Mac).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

export type Isolation = "container" | "process-no-network" | "process-fs-only";

export type AgentSpec = {
  mission: string;
  agent: string;
  /** Absolute path of the agent's entry script (ESM). Mounted/readable read-only. */
  entry: string;
  /** Extra env for the agent; never credentials (the broker holds those). */
  env?: Record<string, string>;
  /** Wall-clock limit, seconds. Default 300. */
  maxSecs?: number;
};

/** What the agent writes on stdout, one JSON object per line. Anything else is dropped. */
export type AgentRequest =
  | { id: number; kind: "call"; token: string; action: string; args?: unknown }
  | { id: number; kind: "message"; message: unknown };

export type RunnerDeps = {
  /** Live = not revoked, not expired, mission open (same source as the broker's). */
  live: (mission: string, agent: string) => Promise<boolean>;
  /** Broker call for the agent (the runner never sees a credential either). */
  call: (token: string, action: string, args: unknown) => Promise<unknown>;
  /** Typed messages to the orchestrator; the reply goes back to the agent. */
  onMessage?: (agent: string, message: unknown) => Promise<unknown>;
  mode?: "process" | "container";
  pollMs?: number;
  /** For containers. */
  image?: string;
};

export type Exit = { code: number | null; reason: "exit" | "revoked" | "timeout" | "killed" };

export type RunHandle = { pid: number | undefined; isolation: Isolation; done: Promise<Exit>; stop(): void };

export type StartResult = { ok: true; handle: RunHandle } | { ok: false; reason: "MANDATE_NOT_LIVE" | "SPAWN_FAILED"; message: string };

/** Whether this Node governs network access under --permission (Node 25+: --allow-net). */
export function nodeGovernsNetwork(): boolean {
  return process.allowedNodeEnvironmentFlags.has("--allow-net");
}

function permissionFlag(): string {
  return process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
}

/** argv for process mode: read only the agent's own directory; nothing else is allowed. */
export function processArgs(entry: string): string[] {
  return [permissionFlag(), `--allow-fs-read=${dirname(entry)}`, entry];
}

/** argv for container mode (docker run ...). */
export function containerArgs(spec: AgentSpec, image = "node:22-alpine"): string[] {
  return [
    "run", "--rm", "-i",
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", "1000:1000",
    "--memory", "256m", "--cpus", "0.5", "--pids-limit", "64",
    "--tmpfs", "/tmp:rw,size=16m",
    "-v", `${spec.entry}:/app/agent.mjs:ro`,
    ...Object.entries(spec.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    image, "node", "/app/agent.mjs",
  ];
}

export async function startAgent(spec: AgentSpec, deps: RunnerDeps): Promise<StartResult> {
  if (!(await deps.live(spec.mission, spec.agent).catch(() => false))) {
    return { ok: false, reason: "MANDATE_NOT_LIVE", message: "the mandate is revoked or expired, or the mission is closed; the agent is not started" };
  }
  const mode = deps.mode ?? "process";
  let child: ChildProcess;
  try {
    child = mode === "container"
      ? spawn("docker", containerArgs(spec, deps.image), { stdio: ["pipe", "pipe", "pipe"], env: {} })
      // A minimal environment: nothing from the runner's own env (no keys, no proxies, no tokens) leaks in.
      : spawn(process.execPath, processArgs(spec.entry), { stdio: ["pipe", "pipe", "pipe"], env: { ...(spec.env ?? {}) } });
  } catch (e) {
    return { ok: false, reason: "SPAWN_FAILED", message: e instanceof Error ? e.message : String(e) };
  }
  const isolation: Isolation = mode === "container" ? "container" : nodeGovernsNetwork() ? "process-no-network" : "process-fs-only";

  let reason: Exit["reason"] = "exit";
  const kill = (why: Exit["reason"]) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    reason = why;
    child.kill("SIGKILL");
  };

  const reply = (id: number, body: unknown) => {
    if (child.stdin?.writable) child.stdin.write(JSON.stringify({ id, ...((body ?? {}) as object) }) + "\n");
  };
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", async (line) => {
    if (line.length > 65_536) return; // oversize lines are dropped, not parsed
    let req: AgentRequest;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof req !== "object" || req === null || !Number.isSafeInteger(req.id)) return;
    if (req.kind === "call" && typeof req.token === "string" && typeof req.action === "string") {
      // Every call is checked against the chain again by the broker; a dead mandate also stops the process.
      if (!(await deps.live(spec.mission, spec.agent).catch(() => false))) return kill("revoked");
      reply(req.id, { result: await deps.call(req.token, req.action, req.args) });
    } else if (req.kind === "message" && deps.onMessage) {
      reply(req.id, { result: await deps.onMessage(spec.agent, req.message) });
    }
  });
  child.stderr?.resume();

  const poll = setInterval(async () => {
    if (!(await deps.live(spec.mission, spec.agent).catch(() => false))) kill("revoked");
  }, deps.pollMs ?? 2_000);
  const timer = setTimeout(() => kill("timeout"), (spec.maxSecs ?? 300) * 1000);

  const done = new Promise<Exit>((resolve) => {
    child.on("exit", (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      resolve({ code, reason });
    });
    child.on("error", () => {
      clearInterval(poll);
      clearTimeout(timer);
      resolve({ code: null, reason: "killed" });
    });
  });
  return { ok: true, handle: { pid: child.pid, isolation, done, stop: () => kill("killed") } };
}
