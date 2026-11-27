import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import {
  ArrowUpCircle,
  Ban,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Loader2,
  Power,
  PowerOff,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import type { ExtensionState } from "@justpostgres/shared";

import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

import { TONE_CLASS } from "@/components/ToneBadge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { InPageHeader } from "@/components/InPageHeader";

const CATEGORY_ORDER = [
  "search",
  "geospatial",
  "scheduling",
  "security",
  "observability",
  "utility",
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  search: "Search and indexing",
  geospatial: "Geospatial",
  scheduling: "Scheduling",
  security: "Security",
  observability: "Observability",
  utility: "Utility",
  other: "Everything else in this image",
};

const BADGE_BASE = "gap-1 border-transparent";

function RestartWarning({
  extension,
  onCancel,
  onConfirm,
  pending,
}: {
  extension: ExtensionState;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Enabling {extension.title} restarts your database
          </DialogTitle>
          <DialogDescription>
            Not a choice this tool is making — Postgres reads{" "}
            <code className="font-mono">shared_preload_libraries</code> once,
            when it starts. A library that was not loaded then cannot be loaded
            later by any means.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <p>
            Every open connection will be dropped and the database will be
            unavailable for a few seconds while it comes back. The extension is
            created once it is up.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending ? <Loader2 className="animate-spin" /> : <RotateCw />}
            {pending ? "Restarting…" : "Restart and enable"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExtensionRow({
  extension,
  onEnable,
  onDisable,
  onUpdate,
  busy,
  working,
}: {
  extension: ExtensionState;
  onEnable: (e: ExtensionState) => void;
  onDisable: (e: ExtensionState) => void;
  onUpdate: (e: ExtensionState) => void;
  /** Some extension is being changed, so every action is disabled. */
  busy: boolean;
  /** This extension is the one being changed, so it shows the spinner. */
  working: boolean;
}) {
  const installed = extension.installedVersion !== null;
  const spinner = <Loader2 className="animate-spin" />;

  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium">
            {extension.title}
          </span>
          {installed && (
            <Badge variant="outline" className={cn(BADGE_BASE, TONE_CLASS.ok)}>
              <CircleCheck className="size-3" />v{extension.installedVersion}
            </Badge>
          )}
          {extension.requiresRestart && (
            <Badge variant="outline" className={cn(BADGE_BASE, TONE_CLASS.warn)}>
              <RotateCw className="size-3" />
              needs a restart
            </Badge>
          )}
          {!extension.availableInImage && (
            <Badge variant="outline" className={cn(BADGE_BASE, TONE_CLASS.neutral)}>
              <Ban className="size-3" />
              not in this image
            </Badge>
          )}
          {extension.updateAvailable && (
            <Badge variant="outline" className={cn(BADGE_BASE, TONE_CLASS.accent)}>
              <ArrowUpCircle className="size-3" />v{extension.defaultVersion}{" "}
              available
            </Badge>
          )}
        </div>

        <p className="mt-1 text-xs text-muted-foreground">
          {extension.description ?? extension.comment ?? "No description."}
        </p>

        {!extension.availableInImage && (
          <p className="mt-1 text-xs text-muted-foreground/80">
            This project's image does not ship it. Rebuilding the image with
            it, and recreating the project on that image, is the only way to
            add it.
          </p>
        )}

        {extension.docsUrl && (
          <a
            href={extension.docsUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1 inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
          >
            Documentation
            <ExternalLink className="size-3" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        )}
      </div>

      <div className="flex shrink-0 gap-2">
        {extension.updateAvailable && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => onUpdate(extension)}
          >
            {working ? spinner : <ArrowUpCircle />}
            Update
          </Button>
        )}
        {installed ? (
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={busy}
            onClick={() => onDisable(extension)}
          >
            {working && !extension.updateAvailable ? spinner : <PowerOff />}
            Disable
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !extension.availableInImage}
            onClick={() => onEnable(extension)}
          >
            {working ? spinner : <Power />}
            Enable
          </Button>
        )}
      </div>
    </div>
  );
}

function ExtensionsSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 2 }, (_, g) => (
        <Card key={g} className="gap-0 divide-y overflow-hidden py-0">
          <div className="px-4 py-2.5">
            <Skeleton className="h-4 w-32" />
          </div>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="space-y-2 px-4 py-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-full max-w-md" />
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}

export default function ExtensionsPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<ExtensionState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    data,
    isLoading,
    error: loadError,
  } = useQuery({
    queryKey: ["extensions", id],
    queryFn: () => api.extensions(id),
    // A restart-requiring enable runs as a job, so the list has to catch up on
    // its own rather than only after the mutation resolves.
    refetchInterval: 3000,
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["extensions", id] });
  const report = (err: unknown) =>
    setError(err instanceof ApiError ? err.message : "Something went wrong.");

  const enable = useMutation({
    mutationFn: (name: string) => api.enableExtension(id, name),
    onSuccess: (result, name) => {
      setError(null);
      setNotice(
        result.mode === "restart"
          ? `Restarting to enable ${name}. It will appear here once Postgres is back.`
          : `${name} is enabled.`,
      );
      invalidate();
    },
    onError: report,
  });

  const disable = useMutation({
    mutationFn: (name: string) => api.disableExtension(id, name),
    onSuccess: (_r, name) => {
      setError(null);
      setNotice(`${name} was dropped.`);
      invalidate();
    },
    onError: report,
  });

  const update = useMutation({
    mutationFn: (name: string) => api.updateExtension(id, name),
    onSuccess: (result, name) => {
      setError(null);
      setNotice(`${name} updated to v${result.version}.`);
      invalidate();
    },
    onError: report,
  });

  const grouped = useMemo(() => {
    const groups = new Map<string, ExtensionState[]>();
    for (const extension of data?.extensions ?? []) {
      const key = extension.category ?? "other";
      groups.set(key, [...(groups.get(key) ?? []), extension]);
    }
    return [...CATEGORY_ORDER, "other"]
      .filter((key) => groups.has(key))
      .map((key) => ({
        key,
        label: CATEGORY_LABELS[key] ?? key,
        items: groups.get(key)!,
      }));
  }, [data]);

  const busy = enable.isPending || disable.isPending || update.isPending;

  // Which extension is mid-mutation, so only its row shows a spinner.
  const workingName = enable.isPending
    ? enable.variables
    : disable.isPending
      ? disable.variables
      : update.isPending
        ? update.variables
        : null;

  const requestEnable = (extension: ExtensionState) => {
    // The warning is shown before the click has any effect, not after.
    if (extension.requiresRestart && !extension.preloaded)
      setConfirming(extension);
    else enable.mutate(extension.name);
  };

  return (
    <>
      <InPageHeader
        title="Extensions"
        description="What this project's image can run. Most turn on instantly; the ones that hook into Postgres at startup need a restart, and say so before you click."
      />

      <div className="space-y-4">
        {notice && (
          <Alert role="status">
            <CircleCheck />
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {isLoading ? (
          <ExtensionsSkeleton />
        ) : loadError ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>
              {loadError instanceof ApiError
                ? loadError.message
                : "Could not read the extension list."}
            </AlertDescription>
          </Alert>
        ) : (
          grouped.map((group) => (
            <Card
              key={group.key}
              className="gap-0 divide-y overflow-hidden py-0"
            >
              <div className="flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-muted-foreground">
                {group.label}
                <Badge variant="secondary" className="tabular-nums">
                  {group.items.length}
                </Badge>
              </div>
              {group.items.map((extension) => (
                <ExtensionRow
                  key={extension.name}
                  extension={extension}
                  busy={busy}
                  working={workingName === extension.name}
                  onEnable={requestEnable}
                  onDisable={(e) => disable.mutate(e.name)}
                  onUpdate={(e) => update.mutate(e.name)}
                />
              ))}
            </Card>
          ))
        )}
      </div>

      {confirming && (
        <RestartWarning
          extension={confirming}
          pending={enable.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const name = confirming.name;
            setConfirming(null);
            enable.mutate(name);
          }}
        />
      )}
    </>
  );
}
