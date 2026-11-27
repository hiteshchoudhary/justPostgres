import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Eye, EyeOff, Loader2, Play, RotateCw, Square, Trash2 } from "lucide-react";
import type { ConnectionEndpoint, ProjectAction } from "@justpostgres/shared";
import { api } from "../lib/api.js";
import { formatBytes, relativeTime } from "@/lib/format";
import ProjectMetricsCard from "../components/ProjectMetricsCard.js";
import { CodeBlock } from "../components/CopyButton";
import { ErrorAlert } from "../components/ErrorAlert";
import { InPageHeader } from "../components/InPageHeader.js";
import { TypeToConfirmDialog } from "../components/TypeToConfirmDialog";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Progress } from "../components/ui/progress";
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";

function EndpointPanel({
    endpoint,
    revealed,
}: {
    endpoint: ConnectionEndpoint;
    revealed: boolean;
}) {
    const canCopy = revealed && Boolean(endpoint.url);
    const details: [string, string][] = [
        ["Host", endpoint.host],
        ["Port", String(endpoint.port)],
        ["User", endpoint.user],
        ["Database", endpoint.database],
    ];

    return (
        <div className="grid gap-4">
            <p className="text-sm text-muted-foreground">{endpoint.description}</p>

            <div className="grid gap-2">
                <CodeBlock
                    value={revealed ? (endpoint.url ?? "") : endpoint.maskedUrl}
                    copyLabel={canCopy ? "Copy connection string" : undefined}
                />
                {revealed && endpoint.psql ? (
                    <CodeBlock value={endpoint.psql} copyLabel="Copy psql command" />
                ) : null}
            </div>

            {endpoint.caveat ? (
                <Alert role="note" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400">
                    <AlertDescription className="text-inherit">{endpoint.caveat}</AlertDescription>
                </Alert>
            ) : null}

            <Separator />

            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                {details.map(([label, value]) => (
                    <div key={label} className="min-w-0">
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd className="mt-0.5 break-all font-mono text-xs">{value}</dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}

function ConnectionCard({ projectId, disabled }: { projectId: string; disabled: boolean }) {
    const [revealed, setRevealed] = useState(false);
    const [selected, setSelected] = useState<string | null>(null);

    const { data, error } = useQuery({
        queryKey: ["connection", projectId, revealed],
        queryFn: () => api.connection(projectId, revealed),
        enabled: !disabled,
        // The revealed form holds a live superuser password; keep it out of the
        // cache once the component is gone.
        gcTime: revealed ? 0 : 5 * 60_000,
    });

    if (disabled) {
        return (
            <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                    Connection strings appear once the project is running.
                </CardContent>
            </Card>
        );
    }

    if (error) {
        return (
            <ErrorAlert
                error={error}
                fallback="Try again in a moment."
                title="Could not load connection details"
            />
        );
    }

    const endpoints = data?.connection.endpoints ?? [];
    const activeKind = endpoints.find((e) => e.kind === selected)?.kind ?? endpoints[0]?.kind ?? "";

    return (
        <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div className="grid gap-1">
                    <CardTitle>Connection</CardTitle>
                    <CardDescription>
                        Choose how your app or client reaches this database.
                    </CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={() => setRevealed((v) => !v)}>
                    {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    {revealed ? "Hide password" : "Reveal password"}
                </Button>
            </CardHeader>

            <CardContent>
                {endpoints.length === 0 ? (
                    <div className="grid gap-3">
                        <Skeleton className="h-9 w-64" />
                        <Skeleton className="h-20 w-full" />
                    </div>
                ) : (
                    <Tabs value={activeKind} onValueChange={(v) => setSelected(String(v))}>
                        <TabsList>
                            {endpoints.map((endpoint) => (
                                <TabsTrigger key={endpoint.kind} value={endpoint.kind}>
                                    {endpoint.label}
                                </TabsTrigger>
                            ))}
                        </TabsList>
                        {endpoints.map((endpoint) => (
                            <TabsContent key={endpoint.kind} value={endpoint.kind} className="mt-4">
                                <EndpointPanel endpoint={endpoint} revealed={revealed} />
                            </TabsContent>
                        ))}
                    </Tabs>
                )}
            </CardContent>
        </Card>
    );
}

export default function ProjectDetailPage() {
    const { id = "" } = useParams();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    const { data, isLoading, error } = useQuery({
        queryKey: ["project", id],
        queryFn: () => api.getProject(id),
        refetchInterval: 3000,
    });

    const { data: jobs } = useQuery({
        queryKey: ["project-jobs", id],
        queryFn: () => api.jobsForProject(id),
        refetchInterval: 2000,
    });

    const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: ["project", id] });
        void queryClient.invalidateQueries({ queryKey: ["projects"] });
    };

    const action = useMutation({
        mutationFn: (a: ProjectAction) => api.projectAction(id, a),
        onSuccess: invalidate,
    });

    const remove = useMutation({
        mutationFn: () => api.deleteProject(id),
        onSuccess: () => {
            invalidate();
            navigate("/projects");
        },
    });

    if (isLoading) {
        return (
            <div className="grid gap-4">
                <InPageHeader title={<Skeleton className="h-6 w-48" />} />
                <Skeleton className="h-40 w-full" />
                <Skeleton className="h-56 w-full" />
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="grid gap-4">
                <InPageHeader title="Project" />
                <ErrorAlert
                    error={error}
                    fallback="Try refreshing the page."
                    title="Could not load this project"
                />
            </div>
        );
    }

    const { project, runtime } = data;
    const busy = project.state === "creating" || project.state === "deleting";
    const activeJob = jobs?.jobs.find((j) => j.state === "running" || j.state === "queued");
    const pendingAction = action.isPending ? action.variables : null;

    const actionButton = (kind: ProjectAction, label: string, Icon: typeof Play) => (
        <Button
            key={kind}
            variant="outline"
            size="sm"
            disabled={action.isPending}
            onClick={() => action.mutate(kind)}
        >
            {pendingAction === kind ? (
                <Loader2 className="size-4 animate-spin" />
            ) : (
                <Icon className="size-4" />
            )}
            {label}
        </Button>
    );

    const actions = (
        <>
            {project.state === "running" ? actionButton("stop", "Stop", Square) : null}
            {project.state === "stopped" || project.state === "failed"
                ? actionButton("start", "Start", Play)
                : null}
            {project.state === "running" ? actionButton("restart", "Restart", RotateCw) : null}
            <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmingDelete(true)}
            >
                <Trash2 className="size-4" />
                Delete
            </Button>
        </>
    );

    return (
        <div className="grid gap-4">
            <InPageHeader
                title="Overview"
                actions={actions}
                description={
                    <>
                        {formatBytes(project.memoryBytes)} memory · {(project.nanoCpus / 1e9).toFixed(1)} CPU
                        {runtime ? ` · container ${runtime.containerExists ? runtime.status : "missing"}` : ""}
                        {` · created ${relativeTime(project.createdAt)}`}
                    </>
                }
            />

            {project.lastError ? (
                <Alert variant="destructive">
                    <AlertDescription className="font-mono text-xs">
                        Last error: {project.lastError}
                    </AlertDescription>
                </Alert>
            ) : null}

            {action.error ? <ErrorAlert error={action.error} fallback="Action failed." /> : null}

            {activeJob ? (
                <Card>
                    <CardContent className="grid gap-2 py-4">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-sm font-medium">{activeJob.type}</span>
                            <span className="text-xs text-muted-foreground">
                                {activeJob.progress?.message ?? activeJob.state}
                            </span>
                        </div>
                        <Progress value={activeJob.progress?.percent ?? 0} />
                    </CardContent>
                </Card>
            ) : null}

            <ProjectMetricsCard projectId={id} running={project.state === "running"} />

            <ConnectionCard projectId={id} disabled={project.state !== "running"} />

            <TypeToConfirmDialog
                open={confirmingDelete}
                title="Delete project"
                description="The container, the volume and every byte in this database are removed. There is no backup to restore from — backups arrive in M4."
                confirmText={project.name}
                confirmLabel="Delete permanently"
                pendingLabel="Deleting…"
                pending={remove.isPending}
                onClose={() => setConfirmingDelete(false)}
                onConfirm={() => remove.mutate()}
            />
        </div>
    );
}
