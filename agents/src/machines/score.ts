// MCR-style machine score (peaq v2, #267): read a machine's events from the EventRegistry logs and score 0-100.
// Labelled "MCR-style score, computed by Fiducia from peaq events": peaq does not serve MCR for testnet machines.
// Pure scoring takes `nowSecs`; log reading goes through an injected LogIo. Refusals are results, not throws.

type Ok<T> = { ok: true } & T;
type Refused = { ok: false; reason: string; message: string };
const refuse = (reason: string, message: string): Refused => ({ ok: false, reason, message });

// One event as read from the EventRegistry log. agung v1 log: address = registry, topics = [sig, machineId, index],
// data = abi(uint8 eventType, uint256 value); the timestamp is the block's. value = USD cents for revenue (type 0).
// Convention (ours, rawData kind "fiducia-outage-v1"): an activity event (type 1) with value > 0 is an OUTAGE
// (value = outage seconds) and counts as a negative event.
export type MachineEvent = { machineId: bigint; index: bigint; eventType: 0 | 1; value: bigint; timestamp: number; txHash: string; block: bigint };
export type RawLog = { topics: string[]; data: string; transactionHash: string; blockNumber: bigint };
export type LogIo = {
  getLogs(q: { address: string; topics: (string | null)[]; fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]>;
  blockNumber(): Promise<bigint>;
  blockTimestamp(block: bigint): Promise<number>;
};

/** topic0 of the agung EventRegistry event (seen on real logs). */
export const EVENT_TOPIC = "0x312cdd3f77b3c79b8a01c27c96ae6f3f2a498fa5b46e3186e95facc6e479be7c";
const DEFAULT_CHUNK = 10_000n;

const topicOf = (id: bigint) => "0x" + id.toString(16).padStart(64, "0");

function decodeLog(l: RawLog, timestamp: number): MachineEvent | null {
  if (l.topics.length < 3 || !/^0x[0-9a-fA-F]*$/.test(l.data) || l.data.length < 2 + 128) return null;
  const eventType = BigInt("0x" + l.data.slice(2, 66));
  if (eventType !== 0n && eventType !== 1n) return null;
  return {
    machineId: BigInt(l.topics[1]!),
    index: BigInt(l.topics[2]!),
    eventType: Number(eventType) as 0 | 1,
    value: BigInt("0x" + l.data.slice(66, 130)),
    timestamp,
    txHash: l.transactionHash,
    block: l.blockNumber,
  };
}

/** Chunked getLogs (default 10_000 blocks per call) from `fromBlock` to the head, sorted by event index. */
export async function readMachineEvents(
  io: LogIo, registry: string, machineId: bigint, fromBlock: bigint, o: { chunk?: bigint } = {},
): Promise<Ok<{ events: MachineEvent[]; toBlock: bigint }> | Refused> {
  const chunk = o.chunk ?? DEFAULT_CHUNK;
  if (chunk < 1n) return refuse("bad-chunk", "chunk must be at least 1 block");
  if (machineId < 0n || fromBlock < 0n) return refuse("bad-input", "machineId and fromBlock must not be negative");
  try {
    const head = await io.blockNumber();
    const logs: RawLog[] = [];
    for (let from = fromBlock; from <= head; from += chunk) {
      const to = from + chunk - 1n < head ? from + chunk - 1n : head;
      logs.push(...(await io.getLogs({ address: registry, topics: [EVENT_TOPIC, topicOf(machineId)], fromBlock: from, toBlock: to })));
    }
    const stamps = new Map<bigint, number>();
    const events: MachineEvent[] = [];
    for (const l of logs) {
      let ts = stamps.get(l.blockNumber);
      if (ts === undefined) { ts = await io.blockTimestamp(l.blockNumber); stamps.set(l.blockNumber, ts); }
      const ev = decodeLog(l, ts);
      if (ev && ev.machineId === machineId) events.push(ev);
    }
    events.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
    return { ok: true, events, toBlock: head };
  } catch (e) {
    return refuse("log-read-failed", `could not read machine events: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
  }
}

export type Grade = "AAA" | "AA" | "A" | "BBB" | "BB" | "B" | "NR" | "Provisioned";
/** `penalty` is zero or negative (-15 per recent outage); the others are non-negative. */
export type ScoreFactors = { bond: number; revenue: number; activity: number; tenure: number; freshness: number; penalty: number };
export type MachineScore = { score: number; grade: Grade; provisioned: boolean; factors: ScoreFactors; events: number; outages7d: number; explain: string };

const DAY = 86_400;
const MIN_EVENTS = 10;
const MIN_SPAN_SECS = 3 * DAY;
const REVENUE_DAY_CENTS = 10n;
const OUTAGE_PENALTY = 15;

const gradeOf = (s: number): Grade =>
  s >= 95 ? "AAA" : s >= 85 ? "AA" : s >= 75 ? "A" : s >= 60 ? "BBB" : s >= 45 ? "BB" : s >= 30 ? "B" : "NR";

export function scoreMachine(events: MachineEvent[], o: { bonded: boolean; nowSecs: number }): MachineScore {
  const now = o.nowSecs;
  const zero: ScoreFactors = { bond: 0, revenue: 0, activity: 0, tenure: 0, freshness: 0, penalty: 0 };
  if (!o.bonded) {
    return { score: 0, grade: "NR", provisioned: false, factors: zero, events: events.length, outages7d: 0,
      explain: "Not bonded, so the machine has no score (NR)." };
  }
  const stamps = events.map((e) => e.timestamp);
  const first = stamps.length ? Math.min(...stamps) : now;
  const last = stamps.length ? Math.max(...stamps) : now;
  const span = last - first;

  // Revenue: UTC days of the last 14 (today included) whose revenue sums to at least 10 cents.
  const today = Math.floor(now / DAY);
  const perDay = new Map<number, bigint>();
  for (const e of events) {
    if (e.eventType !== 0) continue;
    const d = Math.floor(e.timestamp / DAY);
    if (d > today - 14 && d <= today) perDay.set(d, (perDay.get(d) ?? 0n) + e.value);
  }
  let revenueDays = 0;
  for (const v of perDay.values()) if (v >= REVENUE_DAY_CENTS) revenueDays++;

  const recent14 = events.filter((e) => e.timestamp >= now - 14 * DAY && e.timestamp <= now).length;
  const outages7d = events.filter((e) => e.eventType === 1 && e.value > 0n && e.timestamp >= now - 7 * DAY && e.timestamp <= now).length;
  const age = now - last;
  const freshness = !events.length ? 0 : age <= DAY ? 20 : age >= 7 * DAY ? 0 : (20 * (7 * DAY - age)) / (6 * DAY);

  const factors: ScoreFactors = {
    bond: 20,
    revenue: (30 * revenueDays) / 14,
    activity: 20 * Math.min(1, recent14 / 28),
    tenure: events.length ? 10 * Math.min(1, span / DAY / 14) : 0,
    freshness,
    penalty: outages7d ? -OUTAGE_PENALTY * outages7d : 0,
  };

  if (events.length < MIN_EVENTS || span < MIN_SPAN_SECS) {
    return { score: 0, grade: "Provisioned", provisioned: true, factors, events: events.length, outages7d,
      explain: `Provisioned: ${events.length} event${events.length === 1 ? "" : "s"} over ${(span / DAY).toFixed(1)} days; scoring needs at least ${MIN_EVENTS} events over 3 days.` };
  }

  const sum = factors.bond + factors.revenue + factors.activity + factors.tenure + factors.freshness + factors.penalty;
  const score = Math.min(100, Math.max(0, Math.round(sum)));
  const labels: [string, number][] = [["bond", factors.bond], ["revenue", factors.revenue], ["activity", factors.activity],
    ["tenure", factors.tenure], ["freshness", factors.freshness]];
  const [t1, t2] = [...labels].sort((a, b) => b[1] - a[1]) as [[string, number], [string, number]]; // stable: ties keep listed order
  const pen = outages7d > 0 ? `, minus ${-factors.penalty} for ${outages7d} outage${outages7d === 1 ? "" : "s"} in the last 7 days` : "";
  const grade = gradeOf(score);
  return { score, grade, provisioned: false, factors, events: events.length, outages7d,
    explain: `MCR-style score ${score} (${grade}): strongest factors are ${t1[0]} (${t1[1].toFixed(1)}) and ${t2[0]} (${t2[1].toFixed(1)})${pen}.` };
}
