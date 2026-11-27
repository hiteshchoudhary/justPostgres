import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Inbox,
  Loader2,
  Play,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Job, JobState } from "@justpostgres/shared";

import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import { ToneBadge, type Tone } from "@/components/ToneBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";

/**
 * Each state gets an icon and a tone. Colour is never the only signal, so the
 * badge reads correctly in greyscale and for colour-blind users.
 */
const STATE_META: Record<JobState, { icon: LucideIcon; tone: Tone; spin?: boolean }> = {
  queued: { icon: CircleDashed, tone: "neutral" },
  running: { icon: Loader2, tone: "accent", spin: true },
  succeeded: { icon: CircleCheck, tone: "ok" },
  failed: { icon: CircleAlert, tone: "danger" },
  cancelled: { icon: Ban, tone: "warn" },
};

function JobStateBadge({ state }: { state: JobState }) {
  const { icon: Icon, tone, spin } = STATE_META[state];
  return (
    <ToneBadge tone={tone} className="gap-1 capitalize">
      <Icon className={cn("size-3", spin && "animate-spin")} />
      {state}
    </ToneBadge>
  );
}

function JobRow({
  job,
  onCancel,
  cancelling,
}: {
  job: Job;
  onCancel: (id: string) => void;
  cancelling: boolean;
}) {
  const active = job.state === "running" || job.state === "queued";

  return (
    <TableRow className="align-top">
      <TableCell>
        <div className="font-medium">{job.type}</div>
        <div className="mt-0.5 font-mono text-xs text-muted-foreground">
          {job.id.slice(0, 8)}
        </div>
      </TableCell>

      <TableCell>
        <JobStateBadge state={job.state} />
        {job.attempts > 1 && (
          <div className="mt-1 text-xs text-muted-foreground">
            attempt {job.attempts} of {job.maxAttempts}
          </div>
        )}
      </TableCell>

      <TableCell className="w-64">
        {job.progress ? (
          <div className="space-y-1.5">
            <Progress value={job.progress.percent} className="h-1.5" />
            <p className="text-xs text-muted-foreground">
              {job.progress.message ?? `${job.progress.percent}%`}
            </p>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
        {job.lastError && (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert className="mt-px size-3 shrink-0" />
            <span className="break-words">{job.lastError}</span>
          </p>
        )}
      </TableCell>

      <TableCell className="text-xs text-muted-foreground">
        <div>created {relativeTime(job.createdAt)}</div>
        {job.finishedAt && <div>finished {relativeTime(job.finishedAt)}</div>}
      </TableCell>

      <TableCell className="text-right">
        {active && (
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={cancelling}
            onClick={() => onCancel(job.id)}
          >
            {cancelling ? <Loader2 className="animate-spin" /> : <X />}
            Cancel
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

function JobsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-4 p-4">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-muted">
        <Inbox className="size-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">No jobs yet</p>
      <p className="mt-2 max-w-lg text-sm text-muted-foreground">
        Start the 30-second job, then kill the control plane while it runs. On
        restart it picks the job back up from its last checkpoint instead of
        starting over — the property every backup and restore in M4 depends on.
      </p>
    </div>
  );
}

type NoopPayload = Record<string, unknown>;

const DEMO_JOBS = {
  long: { steps: 20, stepDurationMs: 1500 },
  failing: { steps: 5, stepDurationMs: 500, failAtStep: 3 },
} satisfies Record<string, NoopPayload>;

export default function JobsPage() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api.listJobs(50),
    // Poll while the page is open. Cheap against a local SQLite queue, and it
    // makes checkpointing visible, which is the entire point of this page.
    refetchInterval: 1000,
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["jobs"] });

  const enqueue = useMutation({
    mutationFn: (payload: NoopPayload) =>
      api.enqueueJob({ type: "noop", payload }),
    onSuccess: invalidate,
  });

  const cancel = useMutation({
    mutationFn: api.cancelJob,
    onSuccess: invalidate,
  });

  const jobs = data?.jobs ?? [];
  const stats = data?.stats;

  // Each button only shows its spinner when *its* payload is in flight.
  const isEnqueuing = (payload: NoopPayload) =>
    enqueue.isPending && enqueue.variables === payload;

  return (
    <>
      <PageHeader
        title="Jobs"
        description="Durable queue. Long-running work is checkpointed to the database, so a job survives a control-plane restart and resumes where it stopped."
        actions={
          <>
            <Button
              variant="secondary"
              disabled={enqueue.isPending}
              onClick={() => enqueue.mutate(DEMO_JOBS.long)}
            >
              {isEnqueuing(DEMO_JOBS.long) ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Play />
              )}
              Run 30s job
            </Button>
            <Button
              variant="secondary"
              disabled={enqueue.isPending}
              onClick={() => enqueue.mutate(DEMO_JOBS.failing)}
            >
              {isEnqueuing(DEMO_JOBS.failing) ? (
                <Loader2 className="animate-spin" />
              ) : (
                <TriangleAlert />
              )}
              Run failing job
            </Button>
          </>
        }
      />

      {stats && (
        <div className="mb-4 flex flex-wrap gap-2">
          {(Object.entries(stats) as Array<[JobState, number]>).map(
            ([state, count]) => (
              <Badge
                key={state}
                variant="outline"
                className="gap-1.5 px-2.5 py-1 font-normal text-muted-foreground capitalize"
              >
                {state}
                <span className="font-semibold text-foreground tabular-nums">
                  {count}
                </span>
              </Badge>
            ),
          )}
        </div>
      )}

      <Card className="gap-0 overflow-hidden p-0">
        {isLoading ? (
          <JobsSkeleton />
        ) : jobs.length === 0 ? (
          <EmptyState />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="px-4">Job</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Timing</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  onCancel={(id) => cancel.mutate(id)}
                  cancelling={cancel.isPending && cancel.variables === job.id}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </>
  );
}
