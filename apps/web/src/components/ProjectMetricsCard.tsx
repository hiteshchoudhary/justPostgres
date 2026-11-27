import { useQuery } from "@tanstack/react-query";
import type { ProjectMetrics } from "@justpostgres/shared";

import { api } from "@/lib/api";
import { formatBytes } from "@/lib/format";

import { Card } from "@/components/ui/card";

function relativeAge(ms: number | null): string {
  if (ms === null) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 1) return "<1s";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function Stat({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "warn" | "danger";
}) {
  const colour = tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "";
  return (
    <div className="px-4 py-3">
      <div className="text-xs text-content-muted">{label}</div>
      <div className={`mono mt-1 text-lg ${colour}`}>{value}</div>
      {detail ? <div className="mt-0.5 text-xs text-content-subtle">{detail}</div> : null}
    </div>
  );
}

/**
 * The growth line, drawn from stored samples.
 *
 * A sparkline rather than a chart library: the question it answers is "is this
 * going up, and how steeply", and that does not need axes — or 200 KB of
 * JavaScript on a page that is mostly text.
 */
function GrowthSparkline({ metrics }: { metrics: ProjectMetrics }) {
  if (metrics.history.length < 3) return null;

  const values = metrics.history.map((h) => h.databaseBytes);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 100;
      const y = 100 - ((v - min) / span) * 100;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  const growth = metrics.growthBytesPerDay ?? null;

  return (
    <div className="border-t border-border px-4 py-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-content-muted">Database size</span>
        <span className="mono text-xs text-content-subtle">
          {growth === null
            ? `${formatBytes(metrics.databaseBytes)} · not enough history for a trend`
            : `${formatBytes(metrics.databaseBytes)} · ${growth >= 0 ? "+" : ""}${formatBytes(
                Math.abs(growth),
              )}/day`}
        </span>
      </div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="mt-2 h-10 w-full">
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
          className="text-accent"
        />
      </svg>
    </div>
  );
}

/**
 * Per-project metrics, on the page someone already looks at.
 *
 * ARCHITECTURE §9 puts these in the UI rather than behind a Prometheus stack.
 * The selection is deliberately narrow: the numbers that explain the failures a
 * single-host deployment actually hits, and archiving health, which §9 argues
 * is an alert rather than a metric because a project whose WAL archiving has
 * been failing for a week looks perfectly healthy until someone needs it.
 */
export default function ProjectMetricsCard({
  projectId,
  running,
}: {
  projectId: string;
  running: boolean;
}) {
  const { data, error } = useQuery({
    queryKey: ["metrics", projectId],
    queryFn: () => api.metrics(projectId),
    enabled: running,
    refetchInterval: 15_000,
  });

  if (!running) return null;
  if (error) {
    return (
      <Card className="mb-4 gap-0 py-0 px-4 py-3 text-xs text-content-muted">
        Metrics are unavailable while the database is not accepting connections.
      </Card>
    );
  }
  if (!data) return null;

  const connectionPressure = data.maxConnections > 0 ? data.connections / data.maxConnections : 0;

  return (
    <Card className="mb-4 gap-0 py-0">
      {data.archiver.failingNow ? (
        <div className="border-b border-border bg-danger/10 px-4 py-3 text-xs text-danger">
          <strong>WAL archiving is failing.</strong> The most recent attempt failed
          {data.archiver.lastFailedWal ? ` on ${data.archiver.lastFailedWal}` : ""}, and the last
          success was {relativeAge(data.archiver.lastArchivedAt)}. Point-in-time recovery stops
          advancing while this is true — the backups you have stay valid, but the window does not
          move forward.
        </div>
      ) : null}

      <div className="grid divide-x divide-border border-b border-border sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Connections"
          value={`${data.connections} / ${data.maxConnections}`}
          detail={`${data.activeQueries} running`}
          {...(connectionPressure > 0.9
            ? { tone: "danger" as const }
            : connectionPressure > 0.7
              ? { tone: "warn" as const }
              : {})}
        />
        <Stat
          label="Idle in transaction"
          value={String(data.idleInTransaction)}
          detail={
            data.idleInTransaction > 0
              ? "holds locks and blocks vacuum"
              : "nothing holding a transaction open"
          }
          {...(data.idleInTransaction > 0 ? { tone: "warn" as const } : {})}
        />
        <Stat
          label="Cache hit ratio"
          value={data.cacheHitRatio === null ? "—" : `${(data.cacheHitRatio * 100).toFixed(1)}%`}
          detail="reads served from memory"
          {...(data.cacheHitRatio !== null && data.cacheHitRatio < 0.9
            ? { tone: "warn" as const }
            : {})}
        />
        <Stat
          label="Longest query"
          value={duration(data.longestQuerySeconds)}
          detail={`oldest transaction ${duration(data.longestTransactionSeconds)}`}
        />
      </div>

      <GrowthSparkline metrics={data} />

      <div className="grid divide-x divide-border border-t border-border sm:grid-cols-2">
        <Stat
          label="WAL waiting to archive"
          value={formatBytes(data.walBytes)}
          detail={`last archived ${relativeAge(data.archiver.lastArchivedAt)}`}
        />
        <Stat
          label="Archive failures"
          value={String(data.archiver.failedCount)}
          detail={`${data.archiver.archivedCount.toLocaleString()} segments archived`}
          {...(data.archiver.failingNow ? { tone: "danger" as const } : {})}
        />
      </div>

      {data.indexHints.length > 0 ? (
        <div className="border-t border-border px-4 py-3">
          <div className="text-xs text-content-muted">Worth a look</div>
          <ul className="mt-2 space-y-1.5">
            {data.indexHints.map((hint) => (
              <li key={`${hint.kind}:${hint.target}`} className="text-xs">
                <span className="mono text-content">{hint.target}</span>{" "}
                <span className="text-content-subtle">{hint.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {data.slowQueries === null ? (
        <p className="border-t border-border px-4 py-3 text-xs text-content-subtle">
          Enable <span className="mono">pg_stat_statements</span> on the Extensions tab to see which
          queries cost the most time.
        </p>
      ) : data.slowQueries.length > 0 ? (
        <div className="border-t border-border px-4 py-3">
          <div className="text-xs text-content-muted">Most total time</div>
          <div className="mt-2 space-y-2">
            {data.slowQueries.slice(0, 5).map((q) => (
              <div key={q.query} className="min-w-0">
                <p className="mono truncate text-xs text-content">{q.query}</p>
                <p className="mono text-xs text-content-subtle">
                  {q.calls.toLocaleString()} calls · {Math.round(q.totalMs).toLocaleString()}ms total
                  · {q.meanMs}ms mean
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
