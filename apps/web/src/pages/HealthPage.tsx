import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  CircleAlert,
  CircleCheck,
  Cog,
  Container,
  Database,
  HardDrive,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type {
  ComponentHealth,
  ComponentStatus,
  FilesystemUsage,
} from "@justpostgres/shared";

import { api } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

import { ToneBadge, type Tone } from "@/components/ToneBadge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";

/** Icon plus tone, so status never relies on colour alone. */
const STATUS_META: Record<ComponentStatus, { icon: LucideIcon; tone: Tone }> = {
  ok: { icon: CircleCheck, tone: "ok" },
  degraded: { icon: TriangleAlert, tone: "warn" },
  down: { icon: CircleAlert, tone: "danger" },
};

function StatusBadge({ status }: { status: ComponentStatus }) {
  const { icon: Icon, tone } = STATUS_META[status];
  return (
    <ToneBadge tone={tone} className="gap-1 capitalize">
      <Icon className="size-3" />
      {status}
    </ToneBadge>
  );
}

function ComponentRow({
  icon: Icon,
  name,
  detail,
  health,
}: {
  icon: LucideIcon;
  name: string;
  detail: string;
  health: ComponentHealth;
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-3.5">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          <StatusBadge status={health.status} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
        <p className="mt-1 font-mono text-xs break-words text-muted-foreground/80">
          {health.detail}
        </p>
      </div>

      {health.latencyMs !== undefined && (
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          {health.latencyMs}ms
        </span>
      )}
    </div>
  );
}

function formatUptime(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86_400);
  const h = Math.floor((totalSeconds % 86_400) / 3_600);
  const m = Math.floor((totalSeconds % 3_600) / 60);
  const s = totalSeconds % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

/**
 * A bar per filesystem, because "87% used" is a number an operator can act on
 * and "degraded" is not. The reserve is drawn as a marker rather than implied:
 * the point at which justpostgres stops accepting new work should be visible
 * before it is reached, not discovered by being refused.
 */
function DiskRow({ fs }: { fs: FilesystemUsage }) {
  const barColor = !fs.hasHeadroom
    ? "bg-destructive"
    : fs.usedPercent >= 75
      ? "bg-amber-500"
      : "bg-emerald-500";

  const width = Math.min(100, Math.max(2, fs.usedPercent));

  return (
    <div className="px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="flex items-center gap-2 text-sm font-medium">
          <HardDrive className="size-4 text-muted-foreground" />
          {fs.label}
        </span>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {formatBytes(fs.freeBytes)} free of {formatBytes(fs.totalBytes)}
        </span>
      </div>

      <div
        role="progressbar"
        aria-label={`${fs.label} disk usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={width}
        aria-valuetext={`${fs.usedPercent}% used`}
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full transition-[width]", barColor)}
          style={{ width: `${width}%` }}
        />
      </div>

      <p className="mt-1.5 font-mono text-xs text-muted-foreground">
        {fs.path} · {fs.usedPercent}% used
      </p>
      {!fs.hasHeadroom && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-destructive">
          <TriangleAlert className="size-3 shrink-0" />
          Below the reserve. New projects and branches are refused.
        </p>
      )}
    </div>
  );
}

function HealthSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-16 w-full" />
      <Card className="gap-0 divide-y overflow-hidden p-0">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-3.5">
            <Skeleton className="size-8 rounded-md" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-full max-w-md" />
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

export default function HealthPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 5000,
  });

  return (
    <>
      <PageHeader
        title="Health"
        description="Each dependency is reported independently. The control plane stays up when one of them is down — it has to, because explaining the outage is part of its job."
      />

      {isLoading ? (
        <HealthSkeleton />
      ) : error || !data ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Could not reach the control plane</AlertTitle>
          <AlertDescription>
            Retrying every 5 seconds. If this persists, check that the control
            plane process is running.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-4">
          <Card className="flex-row items-center justify-between gap-4 px-4 py-3.5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Overall</span>
                <StatusBadge status={data.status} />
              </div>
              <p className="mt-1 font-mono text-xs break-words text-muted-foreground">
                {data.instanceId} · up {formatUptime(data.uptimeSeconds)}
              </p>
            </div>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {data.version}
            </span>
          </Card>

          <Card className="gap-0 divide-y overflow-hidden py-0">
            <ComponentRow
              icon={Database}
              name="Database"
              detail="SQLite control-plane metadata. Not the projects' Postgres."
              health={data.components.database}
            />
            <ComponentRow
              icon={Container}
              name="Docker"
              detail="Container runtime. Reported as degraded, not fatal: the UI works, provisioning does not."
              health={data.components.docker}
            />
            <ComponentRow
              icon={Cog}
              name="Job worker"
              detail="Polls the queue and holds leases on running jobs."
              health={data.components.worker}
            />
            <ComponentRow
              icon={Archive}
              name="Storage"
              detail="Where project data physically lives. Verified at startup, not assumed."
              health={data.components.storage}
            />
            <ComponentRow
              icon={HardDrive}
              name="Disk"
              detail="A full disk does not slow Postgres down; it stops it. Work that allocates is refused before that happens."
              health={data.components.disk}
            />
          </Card>

          {data.filesystems.length > 0 && (
            <Card className="gap-0 divide-y overflow-hidden py-0">
              {data.filesystems.map((fs) => (
                <DiskRow key={fs.path} fs={fs} />
              ))}
            </Card>
          )}
        </div>
      )}
    </>
  );
}
