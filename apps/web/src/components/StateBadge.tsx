import type { ProjectState } from "@justpostgres/shared";

import { ToneBadge, type Tone } from "@/components/ToneBadge";

const STATE_TONE: Record<ProjectState, Tone> = {
  creating: "accent",
  running: "ok",
  stopped: "neutral",
  failed: "danger",
  deleting: "warn",
  upgrading: "accent",
};

const ANIMATED: ReadonlySet<ProjectState> = new Set(["creating", "deleting", "upgrading"]);

export function StateBadge({ state }: { state: ProjectState }) {
  return (
    <ToneBadge tone={STATE_TONE[state]} dot pulse={ANIMATED.has(state)} className="capitalize">
      {state}
    </ToneBadge>
  );
}
