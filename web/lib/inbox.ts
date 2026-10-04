// The approvals inbox's memory (#73): which missions this browser hired, and their fee deals. A per-viewer
// convenience only: the mission service and the chain stay the source of truth, and the page works without it
// (storage can be blocked or empty), so every read and write is guarded.
const KEY = "deal.missions.v1";
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX = 50;

export type SavedMission = { mission: string; feeDeal: string | null; team: string; at: number };

type Store = Pick<Storage, "getItem" | "setItem">;
const browserStore = (): Store | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** Saved missions, newest first; anything malformed is dropped rather than trusted. */
export function listMissions(store: Store | null = browserStore()): SavedMission[] {
  try {
    const raw = JSON.parse(store?.getItem(KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((m): m is SavedMission =>
        !!m && typeof m === "object" && ADDRESS.test((m as SavedMission).mission) && typeof (m as SavedMission).team === "string"
        && ((m as SavedMission).feeDeal === null || ADDRESS.test(String((m as SavedMission).feeDeal))) && Number.isFinite((m as SavedMission).at))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX);
  } catch {
    return [];
  }
}

export function saveMission(m: SavedMission, store: Store | null = browserStore()): void {
  try {
    const rest = listMissions(store).filter((x) => x.mission !== m.mission);
    store?.setItem(KEY, JSON.stringify([m, ...rest].slice(0, MAX)));
  } catch {
    // storage blocked: the mission page link still works
  }
}

export const missionLink = (m: Pick<SavedMission, "mission" | "feeDeal">) =>
  `/missions?m=${m.mission}${m.feeDeal ? `&fee=${m.feeDeal}` : ""}`;
