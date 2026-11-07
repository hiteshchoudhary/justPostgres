import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Badge, Button, Card, Input, Loading, Modal, PageHeader, formatBytes, relativeTime } from "../components/ui.js";
import { LSN_PATTERN } from "@justpostgres/shared";
import { api, ApiError } from "../lib/api.js";

function formatWhen(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** An input the user can type a wall-clock time into, mapped to epoch millis. */
function toLocalInputValue(ms: number): string {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 19);
}

function RestoreModal({
  projectId,
  window: recoveryWindow,
  onClose,
}: {
  projectId: string;
  window: { earliest: number | null; latest: number | null };
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"latest" | "time" | "lsn">("time");
  const [when, setWhen] = useState(toLocalInputValue(recoveryWindow.latest ?? Date.now()));
  const [lsn, setLsn] = useState("");
  const [name, setName] = useState("");
  const lsnInvalid = mode === "lsn" && !LSN_PATTERN.test(lsn.trim());

  const restore = useMutation({
    mutationFn: () =>
      api.restore(projectId, {
        ...(mode === "time" ? { targetTime: new Date(when).getTime() } : {}),
        ...(mode === "lsn" ? { targetLsn: lsn.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
      }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
      navigate(`/projects/${data.project.id}`);
    },
  });

  return (
    <Modal
      title="Restore to a point in time"
      description="This creates a new project. The one you are restoring from is not touched, so you can inspect the result before deciding anything."
      onClose={onClose}
    >
      <div className="space-y-4">
        <div className="flex gap-1">
          {(["time", "lsn", "latest"] as const).map((option) => (
            <button
              key={option}
              onClick={() => setMode(option)}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                mode === option
                  ? "bg-surface-sunken font-medium text-content"
                  : "text-content-muted hover:text-content"
              }`}
            >
              {option === "time" ? "A point in time" : option === "lsn" ? "A log position" : "Everything, up to now"}
            </button>
          ))}
        </div>

        {mode === "lsn" ? (
          <Input
            label="Restore to log position"
            value={lsn}
            onChange={(e) => setLsn(e.target.value)}
            placeholder="16/B374D848"
            hint="From pg_current_wal_lsn() or a Postgres log line. Stops exactly there, even between two transactions that committed in the same second."
          />
        ) : mode === "time" ? (
          <Input
            label="Restore to"
            type="datetime-local"
            step={1}
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            hint={`Restorable between ${formatWhen(recoveryWindow.earliest)} and ${formatWhen(recoveryWindow.latest)}.`}
          />
        ) : (
          <p className="rounded-md bg-surface-sunken px-3 py-2 text-xs text-content-muted">
            Replays every archived transaction. Use this after losing a database outright.
          </p>
        )}

        <Input
          label="Name for the new project"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="auto"
        />

        {restore.error ? (
          <p className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
            {restore.error instanceof ApiError ? restore.error.message : "Could not start the restore."}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={restore.isPending} disabled={lsnInvalid} onClick={() => restore.mutate()}>
            {restore.isPending ? "Starting…" : "Restore"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Backups that survived a major-version upgrade but cannot restore into it.
 *
 * pgBackRest keeps them, and they are the single most misleading thing in the
 * repository: they look like recovery points and are not. Saying so where the
 * window is displayed is the only place it would be read in time.
 */
function StrandedNote({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <p className="mt-2 text-xs text-warn">
      {count} older backup{count === 1 ? " is" : "s are"} still in the repository from before a
      major-version upgrade. {count === 1 ? "It cannot" : "They cannot"} restore into the version
      running now, so {count === 1 ? "it is" : "they are"} not counted above.
    </p>
  );
}

/**
 * Offer to move this project's backups off the host's disk.
 *
 * Only shown when the instance has object storage configured and this project
 * is not already using it — an offer nobody can act on is noise, and the place
 * to configure storage is once, on the Instance page, not once per project.
 */
function MoveToObjectStorage({
  projectId,
  repoType,
  awaitingFirstBackup,
}: {
  projectId: string;
  repoType: string;
  awaitingFirstBackup: boolean;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const storage = useQuery({ queryKey: ["object-storage"], queryFn: api.objectStorage });
  const jobs = useQuery({
    queryKey: ["jobs", projectId],
    queryFn: () => api.jobsForProject(projectId),
    enabled: repoType === "s3" && awaitingFirstBackup,
  });

  const migrate = useMutation({
    mutationFn: () => api.migrateBackupsToObjectStorage(projectId),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["backups", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const configured = Boolean(storage.data?.settings);

  // A move that failed partway: pointed at the bucket, nothing restorable in
  // it. Without this the project sat unprotected with no way to finish.
  const lastMove = jobs.data?.jobs.find((job) => job.type === "backup.migrate");
  if (repoType === "s3" && awaitingFirstBackup && lastMove?.state === "failed") {
    return (
      <Card className="mb-4 border-danger/30 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl">
            <h3 className="text-sm font-medium">Moving backups to object storage did not finish</h3>
            <p className="mt-1 text-xs text-content-muted">
              This project now archives to the bucket but has no backup there yet, so it cannot be restored
              until the move completes. Retrying picks up where it stopped.
            </p>
            {lastMove.lastError ? (
              <pre className="mt-2 whitespace-pre-wrap text-xs text-danger">{lastMove.lastError}</pre>
            ) : null}
            {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
          </div>
          <Button onClick={() => migrate.mutate()} loading={migrate.isPending}>
            {migrate.isPending ? "Retrying…" : "Retry the move"}
          </Button>
        </div>
      </Card>
    );
  }

  if (repoType === "s3" || storage.isLoading) return null;

  // Local-only backups are the default, and they are not disaster recovery:
  // the recovery window is real right up until the disk it lives on dies. Say
  // so where the window is shown, rather than only in the install guide.
  if (!configured) {
    return (
      <Card className="mb-4 border-warn/30 p-4">
        <h3 className="text-sm font-medium">Backups are on this host only</h3>
        <p className="mt-1 max-w-2xl text-xs text-content-muted">
          Point-in-time restore protects against mistakes — a dropped table, a bad migration. It does not
          survive losing this machine, because the backups live on the same disk as the database.
          Configure object storage (S3, R2 or any S3-compatible bucket) on the{" "}
          <Link to="/instance" className="underline">
            Instance page
          </Link>{" "}
          to keep a copy off the host.
        </p>
      </Card>
    );
  }

  return (
    <Card className="mb-4 border-accent/30 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h3 className="text-sm font-medium">
            Move these backups to {storage.data?.settings?.bucket}
          </h3>
          <p className="mt-1 text-xs text-content-muted">
            This project still backs up to a volume on this host, which means a host failure takes the
            database and its backups together. Moving restarts the database for a few seconds, creates
            a stanza in the bucket and takes a full backup before reporting success.
          </p>
          <p className="mt-2 text-xs text-warn">
            Backups taken before the move stay in the local volume and cannot be restored from
            afterwards. The volume is kept, so nothing is destroyed — but the recovery window starts
            again from the new full backup.
          </p>
          {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
        </div>
        <Button onClick={() => migrate.mutate()} loading={migrate.isPending}>
          {migrate.isPending ? "Moving…" : "Move to object storage"}
        </Button>
      </div>
    </Card>
  );
}

export default function BackupsPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const [restoring, setRestoring] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["backups", id],
    queryFn: () => api.backups(id),
    refetchInterval: 5000,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["backups", id] });
  const runBackup = useMutation({ mutationFn: () => api.runBackup(id), onSuccess: invalidate });
  const verify = useMutation({ mutationFn: () => api.verifyBackup(id), onSuccess: invalidate });
  const promote = useMutation({
    mutationFn: () => api.promote(id),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["project", id] });
    },
  });

  if (isLoading) {
    return <Loading rows={2} />;
  }
  if (error || !data) {
    return (
      <Card className="px-6 py-14 text-center text-sm text-danger">
        {error instanceof ApiError ? error.message : "Could not read backup status."}
      </Card>
    );
  }

  const { status, runs, checks } = data;
  const lastCheck = checks[0];

  return (
    <>
      <PageHeader
        title="Backups"
        description="Continuous write-ahead log archiving, so this project can be restored to any moment in its recovery window — not just to last night."
        actions={
          <>
            <Button variant="secondary" loading={verify.isPending} onClick={() => verify.mutate()}>
              Verify restore
            </Button>
            <Button variant="secondary" loading={runBackup.isPending} onClick={() => runBackup.mutate()}>
              Back up now
            </Button>
            <Button disabled={status.awaitingFirstBackup} onClick={() => setRestoring(true)}>
              Restore…
            </Button>
          </>
        }
      />

      {status.archivingHealthy === false ? (
        <Card className="mb-4 border-danger/50 p-4">
          <div className="mb-1 flex items-center gap-2">
            <Badge tone="danger">archiving is failing</Badge>
            <span className="text-xs text-content-muted">
              checked {relativeTime(status.archivingCheckedAt)}
            </span>
          </div>
          <p className="text-xs text-content-muted">
            New transactions are not reaching the backup repository. This project can only be restored
            to the end of its most recent backup until this is fixed.
          </p>
          {status.archivingError ? (
            <pre className="mono mt-2 max-h-40 overflow-auto rounded-md bg-surface-sunken px-3 py-2 text-xs">
              {status.archivingError}
            </pre>
          ) : null}
        </Card>
      ) : null}

      {status.awaitingFirstBackup ? (
        <Card className="mb-4 border-warn/50 px-4 py-3">
          <p className="text-xs text-warn">
            No completed backup yet, so there is currently <strong>no recovery point at all</strong>.
            The first one runs on the schedule, or start it now.
          </p>
        </Card>
      ) : null}

      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <Card className="p-4">
          <div className="text-xs font-medium text-content-muted">Recovery window</div>
          {status.window && !status.window.empty ? (
            <>
              <p className="mono mt-2 text-sm">{formatWhen(status.window.earliest)}</p>
              <p className="my-1 text-xs text-content-subtle">to</p>
              <p className="mono text-sm">{formatWhen(status.window.latest)}</p>
              <p className="mt-3 text-xs text-content-subtle">
                {status.window.backupCount} backup{status.window.backupCount === 1 ? "" : "s"} ·
                keeping {status.retentionFull} full
              </p>
              <StrandedNote count={status.window.strandedByUpgrade} />
            </>
          ) : (
            <>
              <p className="mt-2 text-sm text-content-muted">Nothing restorable yet.</p>
              <StrandedNote count={status.window?.strandedByUpgrade ?? 0} />
            </>
          )}
        </Card>

        <Card className="p-4">
          <div className="text-xs font-medium text-content-muted">Schedule</div>
          <dl className="mt-2 space-y-1.5 text-xs">
            {[
              ["Every", `${status.intervalHours}h`],
              ["Full backup every", `${status.fullEveryDays} days`],
              ["Last success", status.lastSuccessAt ? relativeTime(status.lastSuccessAt) : "never"],
              ["Next run", status.nextRunAt ? relativeTime(status.nextRunAt) : "not scheduled"],
              ["Repository", status.repoType === "s3" ? "object storage" : "local disk"],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-content-subtle">{label}</dt>
                <dd className="mono">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <MoveToObjectStorage projectId={id} repoType={status.repoType} awaitingFirstBackup={status.awaitingFirstBackup} />

      <Card className="mb-4 p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-content-muted">Last restore verification</div>
            <p className="mt-1 text-xs text-content-subtle">
              A backup nobody has restored is a hypothesis. This one was actually restored and started.
            </p>
          </div>
          {lastCheck ? (
            <Badge tone={lastCheck.status === "passed" ? "ok" : lastCheck.status === "failed" ? "danger" : "accent"}>
              {lastCheck.status}
            </Badge>
          ) : (
            <Badge tone="warn">never run</Badge>
          )}
        </div>
        {lastCheck ? (
          <p className="mono mt-2 text-xs text-content-muted">
            {lastCheck.detail ?? lastCheck.error ?? ""} · {relativeTime(lastCheck.startedAt)}
          </p>
        ) : null}
      </Card>

      {promote.error ? (
        <Card className="mb-4 border-danger/40 px-4 py-3 text-xs text-danger">
          {promote.error instanceof ApiError ? promote.error.message : "Promote failed."}
        </Card>
      ) : null}

      <Card className="mb-4 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-xs font-medium">Promote this project</div>
            <p className="mt-1 text-xs text-content-muted">
              Swaps this project's hostname and port with the project it was restored from, so an
              application reaches the recovered data without a config change. Only available on a
              restored project.
            </p>
          </div>
          <Button variant="secondary" loading={promote.isPending} onClick={() => promote.mutate()}>
            {promote.isPending ? "Promoting…" : "Promote"}
          </Button>
        </div>
      </Card>

      <Card>
        <div className="border-b border-border px-4 py-2.5 text-xs font-medium text-content-muted">
          Recent runs
        </div>
        {runs.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-content-muted">No runs yet.</p>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    <Badge
                      tone={run.status === "succeeded" ? "ok" : run.status === "failed" ? "danger" : "accent"}
                    >
                      {run.status}
                    </Badge>
                  </td>
                  <td className="mono px-4 py-2.5">{run.type}</td>
                  <td className="mono px-4 py-2.5 text-content-muted">{run.label ?? "—"}</td>
                  <td className="px-4 py-2.5 text-content-muted">
                    {run.sizeBytes ? formatBytes(run.sizeBytes) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-content-muted">{relativeTime(run.startedAt)}</td>
                  <td className="max-w-md px-4 py-2.5 text-danger">
                    {run.error ? run.error.split("\n")[0] : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {restoring && status.window ? (
        <RestoreModal projectId={id} window={status.window} onClose={() => setRestoring(false)} />
      ) : null}
    </>
  );
}
