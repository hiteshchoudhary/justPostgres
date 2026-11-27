import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  DatabaseBackup,
  Download,
  KeyRound,
  Loader2,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type { AuditEntry } from "@justpostgres/shared";

import { api, ApiError } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import ObjectStorageCard from "@/components/ObjectStorageCard";
import { PageHeader } from "@/components/PageHeader";

/**
 * Actions are stored as dotted identifiers because they are meant to be
 * grepped in a log; a person reading a table wants a sentence.
 */
const ACTION_LABELS: Record<string, string> = {
  "admin.setup": "claimed this instance",
  "admin.setup_failed": "tried to claim this instance with a bad token",
  "admin.login": "signed in",
  "admin.login_failed": "failed to sign in",
  "admin.password_changed": "changed the administrator password",

  "project.create": "created a project",
  "project.delete": "deleted a project",
  "project.start": "started a project",
  "project.stop": "stopped a project",
  "project.restart": "restarted a project",
  "project.credentials_revealed": "revealed a project's database password",
  "project.promoted": "promoted a restored project",
  "project.upgrade": "started a major-version upgrade",
  "project.upgrade.discard_previous": "deleted a pre-upgrade data directory",

  "backup.run_requested": "asked for a backup",
  "backup.config_changed": "changed the backup schedule",
  "backup.verify_requested": "asked to verify a backup by restoring it",
  "restore.started": "started a restore",
  "branch.create": "created a branch",
  "branch.expiry_changed": "changed a branch's expiry",

  "extension.enable": "enabled an extension",
  "extension.disable": "disabled an extension",
  "extension.update": "updated an extension",

  "api.enable": "turned the REST API on",
  "api.disable": "turned the REST API off",
  "api.keys_rotated": "rotated the API keys",
  "api.keys_revealed": "revealed the API keys",
  "security.table_exposed": "exposed a table through the API",
  "security.table_unexposed": "removed a table from the API",
  "security.policy_created": "created a row-level security policy",
  "security.policy_dropped": "dropped a row-level security policy",

  "data.insert": "inserted a row",
  "data.update": "updated a row",
  "data.delete": "deleted a row",
  "data.query": "ran SQL",

  "control_plane.backup": "backed up the metadata store",
  "control_plane.backup_downloaded": "downloaded a metadata backup",
};

type VerifyResult = { ok: boolean; detail: string };

function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-foreground">{children}</code>;
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  // entry.at is epoch milliseconds; <time dateTime> needs a string.
  const at = new Date(entry.at);

  let payload: Record<string, unknown> | null = null;
  try {
    payload = entry.payload ? JSON.parse(entry.payload) : null;
  } catch {
    payload = null;
  }

  // Deletions, failures and anything that put a secret on someone's screen.
  // These are the rows a person scanning this page is looking for.
  const notable = /delete|failed|discard|revealed|drop|promote/.test(
    entry.action,
  );

  const payloadText = payload
    ? Object.entries(payload)
        .map(
          ([k, v]) =>
            `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`,
        )
        .join(" · ")
    : null;

  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium">{entry.actor}</span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5",
              notable
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted-foreground",
            )}
          >
            {notable && <TriangleAlert className="size-3.5 shrink-0" />}
            {ACTION_LABELS[entry.action] ?? entry.action}
          </span>
        </div>
        {payloadText && (
          <p
            className="mt-1 truncate font-mono text-xs text-muted-foreground/80"
            title={payloadText}
          >
            {payloadText}
          </p>
        )}
      </div>

      <div className="shrink-0 text-right font-mono text-xs text-muted-foreground">
        <time dateTime={at.toISOString()}>{at.toLocaleString()}</time>
        {entry.ip && <p>{entry.ip}</p>}
      </div>
    </div>
  );
}

function AuditSkeleton() {
  return (
    <div className="space-y-3 p-4">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

export default function AdminPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<string, VerifyResult>>({});

  const audit = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.audit({ limit: 200 }),
  });
  const backups = useQuery({
    queryKey: ["cp-backups"],
    queryFn: api.controlPlaneBackups,
    refetchInterval: 30_000,
  });

  const toMessage = (err: unknown) =>
    err instanceof ApiError ? err.message : String(err);

  const run = useMutation({
    mutationFn: api.runControlPlaneBackup,
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["cp-backups"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
    onError: (err) => setError(toMessage(err)),
  });

  const verify = useMutation({
    mutationFn: (name: string) => api.verifyControlPlaneBackup(name),
    onSuccess: (result, name) =>
      setVerified((prev) => ({
        ...prev,
        [name]: { ok: result.ok, detail: result.detail },
      })),
    onError: (err) => setError(toMessage(err)),
  });

  const backupList = backups.data?.backups ?? [];
  const entries = audit.data?.entries ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Instance"
        description="What this control plane has been asked to do, and what would survive losing it."
        className="mb-0"
      />

      {error && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <ObjectStorageCard />

      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3.5">
          <div className="min-w-0">
            <h2 className="text-sm font-medium">Metadata store backups</h2>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              The projects themselves are backed up by pgBackRest. This is the
              control plane's own database — which projects exist, where their
              containers are, and their encrypted credentials. Lose it and the
              databases keep running with nothing able to reach them.
            </p>
            <p className="mt-2 flex max-w-2xl items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <KeyRound className="mt-px size-3.5 shrink-0" />
              <span>
                These files do not contain <Code>JP_MASTER_KEY</Code>, and are
                useless without it. Keep the key somewhere else — a backup
                stored next to its key is one theft, not two.
              </span>
            </p>
          </div>

          <Button
            variant="secondary"
            disabled={run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <DatabaseBackup />
            )}
            {run.isPending ? "Backing up…" : "Back up now"}
          </Button>
        </div>

        {backups.data?.status.lastError && (
          <p className="flex items-start gap-1.5 border-b px-4 py-2.5 text-xs text-destructive">
            <CircleAlert className="mt-px size-3.5 shrink-0" />
            Last attempt failed: {backups.data.status.lastError}
          </p>
        )}

        {backups.isLoading ? (
          <div className="p-4">
            <Skeleton className="h-10 w-full" />
          </div>
        ) : backupList.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No backups yet. Select “Back up now” to create the first one.
          </p>
        ) : (
          <div className="divide-y">
            {backupList.map((b) => {
              const result = verified[b.name];
              const verifying = verify.isPending && verify.variables === b.name;

              return (
                <div
                  key={b.name}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-sm break-all">{b.name}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {formatBytes(b.sizeBytes)} · sha256 {b.sha256.slice(0, 16)}…
                    </p>
                    {result && (
                      <p
                        className={cn(
                          "mt-1 flex items-start gap-1.5 font-mono text-xs",
                          result.ok
                            ? "text-emerald-700 dark:text-emerald-400"
                            : "text-destructive",
                        )}
                      >
                        {result.ok ? (
                          <CircleCheck className="mt-px size-3.5 shrink-0" />
                        ) : (
                          <CircleX className="mt-px size-3.5 shrink-0" />
                        )}
                        {result.ok ? `Verified — ${result.detail}` : result.detail}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={verifying}
                      onClick={() => verify.mutate(b.name)}
                    >
                      {verifying ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <ShieldCheck />
                      )}
                      Verify
                    </Button>
                    <a
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                      href={`/api/admin/control-plane-backups/${encodeURIComponent(b.name)}/download`}
                    >
                      <Download />
                      Download
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="border-t px-4 py-3 text-xs text-muted-foreground">
          To restore: stop the control plane, put the file where{" "}
          <Code>JP_DATA_DIR</Code> is empty, and start it with{" "}
          <Code>JP_RESTORE_CONTROL_PLANE_FROM</Code> pointing at it. It refuses
          to overwrite an existing store, so leaving that variable set cannot
          roll you back later.
        </p>
      </Card>

      <section>
        <div className="mb-1.5 flex items-center gap-2">
          <h2 className="text-sm font-medium">Audit log</h2>
          <Badge variant="secondary" className="tabular-nums">
            {entries.length}
          </Badge>
        </div>
        <p className="mb-3 max-w-3xl text-xs text-muted-foreground">
          Every action that changed something, with who did it and from where. A
          tool holding superuser credentials for every database on the host has
          to be able to answer “who deleted that”.
        </p>

        <Card className="gap-0 overflow-hidden py-0">
          {audit.isLoading ? (
            <AuditSkeleton />
          ) : entries.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Nothing recorded yet. Actions that change something will appear
              here.
            </p>
          ) : (
            <div className="divide-y">
              {entries.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
