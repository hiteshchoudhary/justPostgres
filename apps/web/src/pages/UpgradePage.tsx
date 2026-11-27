import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { PG_MAJOR_VERSIONS, type UpgradeRecord } from "@justpostgres/shared";
import { api, ApiError } from "@/lib/api";
import { InPageHeader } from "@/components/InPageHeader";
import { ToneBadge, type Tone } from "@/components/ToneBadge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const STATE_TONE: Record<UpgradeRecord["state"], Tone> = {
  running: "accent",
  succeeded: "ok",
  failed: "danger",
  rolled_back: "warn",
};

function formatWhen(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : "—";
}

/**
 * What the manifest comparison found.
 *
 * Shown after the fact rather than only used as a gate, because "5,000 rows in
 * three tables came across" is the reassurance someone wants the day after an
 * upgrade, and it is already recorded.
 */
function ManifestSummary({ upgrade }: { upgrade: UpgradeRecord }) {
  if (!upgrade.manifestAfter) return null;
  let after: { databases: string[]; roles: string[]; tables: Record<string, number> };
  try {
    after = JSON.parse(upgrade.manifestAfter);
  } catch {
    return null;
  }
  return (
    <p className="mono mt-2 text-xs text-content-subtle">
      verified {after.databases.length} database{after.databases.length === 1 ? "" : "s"} ·{" "}
      {Object.keys(after.tables).length} tables · {after.roles.length} roles
    </p>
  );
}

export default function UpgradePage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const project = useQuery({
    queryKey: ["project", id],
    queryFn: () => api.getProject(id),
    refetchInterval: 5000,
  });

  const history = useQuery({
    queryKey: ["upgrades", id],
    queryFn: () => api.upgrades(id),
    refetchInterval: 5000,
  });

  const plan = useQuery({
    queryKey: ["upgrade-plan", id, target],
    queryFn: () => api.upgradePlan(id, target!),
    enabled: target !== null,
  });

  const start = useMutation({
    mutationFn: () => api.startUpgrade(id, target!),
    onSuccess: () => {
      setTarget(null);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["upgrades", id] });
      void queryClient.invalidateQueries({ queryKey: ["project", id] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const discard = useMutation({
    mutationFn: (upgradeId: string) => api.discardPreviousData(id, upgradeId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["upgrades", id] }),
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const current = project.data?.project.pgMajor;
  const available = PG_MAJOR_VERSIONS.filter((v) => current !== undefined && v > current);
  const upgrades = history.data?.upgrades ?? [];
  const inFlight = upgrades.find((u) => u.state === "running");

  return (
    <>
      <InPageHeader
        title="Postgres version"
        description="An upgrade dumps every database out of the running version and loads it into the new one. The old data directory is kept afterwards, untouched, so the way back is starting it again rather than restoring a backup."
      />

      {error ? (
        <Card className="mb-4 gap-0 py-0 border-danger/40 px-4 py-3 text-sm text-danger">{error}</Card>
      ) : null}

      <Card className="mb-4 gap-0 py-0 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium text-content-muted">Running</div>
            <p className="mono mt-1 text-lg">Postgres {current ?? "—"}</p>
          </div>

          {inFlight ? (
            <ToneBadge tone="accent">upgrading to {inFlight.toMajor}</ToneBadge>
          ) : available.length === 0 ? (
            <p className="text-sm text-content-muted">
              Already on the newest version this build knows about.
            </p>
          ) : (
            <div className="flex items-center gap-2">
              {available.map((v) => (
                <Button key={v} variant="secondary" onClick={() => setTarget(v)}>
                  Upgrade to {v}
                </Button>
              ))}
            </div>
          )}
        </div>
      </Card>

      {upgrades.length > 0 ? (
        <Card className="gap-0 py-0">
          {upgrades.map((u) => (
            <div key={u.id} className="border-b border-border px-4 py-3.5 last:border-0">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="mono text-sm">
                      {u.fromMajor} → {u.toMajor}
                    </span>
                    <ToneBadge tone={STATE_TONE[u.state]}>{u.state.replace("_", " ")}</ToneBadge>
                  </div>
                  <p className="mt-1 text-xs text-content-subtle">
                    {formatWhen(u.startedAt)}
                    {u.finishedAt ? ` · finished ${formatWhen(u.finishedAt)}` : ""}
                  </p>
                  {u.error ? (
                    <p className="mono mt-2 whitespace-pre-wrap text-xs text-danger">{u.error}</p>
                  ) : null}
                  <ManifestSummary upgrade={u} />
                  {u.previousVolumeName && !u.previousDiscardedAt && u.state === "succeeded" ? (
                    <p className="mono mt-2 text-xs text-content-subtle">
                      pre-upgrade data kept as {u.previousVolumeName}
                    </p>
                  ) : null}
                  {u.previousDiscardedAt ? (
                    <p className="mono mt-2 text-xs text-content-subtle">
                      pre-upgrade data deleted {formatWhen(u.previousDiscardedAt)}
                    </p>
                  ) : null}
                </div>

                {u.state === "succeeded" && u.previousVolumeName && !u.previousDiscardedAt ? (
                  <Button
                    variant="secondary"
                    disabled={discard.isPending}
                    onClick={() => discard.mutate(u.id)}
                  >
                    {discard.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                    Delete old data
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </Card>
      ) : null}

      {target !== null ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setTarget(null);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Upgrade to Postgres {target}</DialogTitle>
              <DialogDescription>
                Read this before confirming. The database goes offline part way through, and its recovery point resets.
              </DialogDescription>
            </DialogHeader>
            {plan.isLoading ? (
              <p className="text-sm text-content-muted">Working out what this involves…</p>
            ) : plan.error || !plan.data ? (
              <p className="text-sm text-danger">
                {plan.error instanceof ApiError ? plan.error.message : "Could not plan the upgrade."}
              </p>
            ) : (
              <>
                <ol className="list-decimal space-y-1 pl-5 text-xs text-content-muted">
                  {plan.data.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>

                <div className="mt-4 space-y-2">
                  {plan.data.warnings.map((w) => (
                    <div key={w} className="rounded-md bg-warn/10 px-3 py-2.5 text-xs text-warn">
                      {w}
                    </div>
                  ))}
                </div>

                <DialogFooter>
                  <Button variant="secondary" onClick={() => setTarget(null)}>
                    Cancel
                  </Button>
                  <Button
                    disabled={!plan.data.imageAvailable || start.isPending}
                    onClick={() => start.mutate()}
                  >
                    {start.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                    {start.isPending ? "Starting…" : `Upgrade to ${target}`}
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
