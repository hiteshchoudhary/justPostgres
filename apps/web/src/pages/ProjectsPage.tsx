import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  PG_MAJOR_VERSIONS,
  TRANSIENT_PROJECT_STATES,
  type PgMajorVersion,
  type Project,
} from "@justpostgres/shared";
import {
  Activity,
  ArrowUpRight,
  Check,
  Cpu,
  Database,
  HardDrive,
  Loader2,
  Plus,
  Search,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { api } from "../lib/api.js";
import { ErrorAlert } from "../components/ErrorAlert";
import { StateBadge } from "../components/StateBadge";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Skeleton } from "../components/ui/skeleton";
import { formatBytes, relativeTime } from "@/lib/format";

function Metric({
  label,
  value,
  icon: Icon,
  detail,
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  detail?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border bg-card px-4 py-3.5">
      <div className="absolute -right-10 -top-12 size-28 rounded-full bg-primary/5 blur-2xl" />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
        </div>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
          <Icon className="size-4" />
        </span>
      </div>
      {detail ? <p className="relative mt-2 text-[11px] text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function initials(name: string): string {
  return (
    name
      .split(/[\s\-_]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") || "DB"
  );
}

function CreateProjectDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [pgMajor, setPgMajor] = useState<PgMajorVersion>(17);
  const [memoryMb, setMemoryMb] = useState(512);
  const [cpus, setCpus] = useState(1);

  const create = useMutation({
    mutationFn: () =>
      api.createProject({ name: name.trim(), pgMajor, memoryMb, cpus }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    create.mutate();
  };

  const valid =
    name.trim().length > 0 &&
    memoryMb >= 128 &&
    memoryMb <= 65536 &&
    cpus >= 0.1 &&
    cpus <= 32;

  const memoryFill = Math.min(100, Math.max(0, ((memoryMb - 128) / (65536 - 128)) * 100));
  const cpuFill = Math.min(100, Math.max(0, ((cpus - 0.1) / (32 - 0.1)) * 100));

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
    <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <div className="grid sm:grid-cols-[0.9fr_1.1fr]">
          <div className="border-b bg-muted/30 p-5 md:border-b-0 md:border-r">
            <span className="flex size-10 items-center justify-center rounded-xl border bg-background shadow-sm">
              <Database className="size-5 text-primary" />
            </span>
            <DialogHeader className="mt-4 gap-2">
              <DialogTitle className="text-xl tracking-tight">New project</DialogTitle>
              <DialogDescription>
                A dedicated Postgres container with its own volume and superuser.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-6 rounded-xl border bg-background/70 p-4">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Provisioning plan
              </p>
              <div className="mt-3 grid gap-3 text-xs">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-muted-foreground">Name</span>
                  <span className="max-w-[10rem] truncate font-mono">{name || "—"}</span>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-muted-foreground">Version</span>
                                  <span className="whitespace-nowrap font-mono">Postgres {pgMajor}</span>
                </div>
                <div className="grid gap-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-muted-foreground">Memory ceiling</span>
                    <span className="font-mono">{formatBytes(memoryMb * 1024 * 1024)}</span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-300"
                      style={{ width: `${memoryFill}%` }}
                    />
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-muted-foreground">CPU ceiling</span>
                    <span className="font-mono">{cpus.toFixed(1)} vCPU</span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-300"
                      style={{ width: `${cpuFill}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              The version is pinned for the life of the project. Limits are hard ceilings, so one
              project cannot starve its neighbours.
            </p>
          </div>

          <form onSubmit={onSubmit} className="flex min-w-0 flex-col">
            <div className="grid gap-4 p-5">
              <div className="grid gap-2">
                <Label htmlFor="project-name">Name</Label>
                <Input
                  id="project-name"
                  required
                  autoFocus
                  maxLength={64}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="my-app"
                  className="font-mono"
                />
              </div>

              <div className="grid gap-2">
                <p className="text-sm font-medium">Postgres version</p>
                <div className="grid grid-cols-3 gap-2">
                  {PG_MAJOR_VERSIONS.map((version) => (
                    <Button
                      key={version}
                      type="button"
                      size="sm"
                      variant={pgMajor === version ? "default" : "outline"}
                      aria-pressed={pgMajor === version}
                      onClick={() => setPgMajor(version)}
                    >
                      {pgMajor === version ? <Check className="size-3.5" /> : null}
                      {version}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="project-memory">Memory (MB)</Label>
                  <Input
                    id="project-memory"
                    type="number"
                    min={128}
                    max={65536}
                    step={128}
                    value={memoryMb}
                    onChange={(event) => setMemoryMb(Number(event.target.value))}
                    className="font-mono"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="project-cpus">CPUs</Label>
                  <Input
                    id="project-cpus"
                    type="number"
                    min={0.1}
                    max={32}
                    step={0.1}
                    value={cpus}
                    onChange={(event) => setCpus(Number(event.target.value))}
                    className="font-mono"
                  />
                </div>
              </div>

              {create.error ? (
                <ErrorAlert error={create.error} fallback="Could not create project." />
              ) : null}
            </div>

            <DialogFooter className="mx-0 mb-0 mt-auto rounded-b-none px-5 py-4">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!valid || create.isPending}>
                {create.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
                {create.isPending ? "Creating…" : "Create project"}
              </Button>
            </DialogFooter>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const working = TRANSIENT_PROJECT_STATES.includes(project.state);

  return (
    <tr className="group relative border-b transition-colors last:border-0 hover:bg-muted/40">
      <td className="relative px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 font-mono text-[11px] font-semibold text-muted-foreground transition-colors group-hover:border-primary/30 group-hover:text-primary">
            {initials(project.name)}
          </span>
          <div className="min-w-0">
            <Link
              to={`/projects/${project.id}`}
              className="font-medium transition-colors group-hover:text-primary after:absolute after:inset-0 after:content-['']"
            >
              {project.name}
            </Link>
            <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
              <span className="truncate">{project.ref}</span>
              {project.parentProjectId ? (
                <span className="rounded border px-1 py-px text-[10px] uppercase tracking-wide">
                  branch
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge state={project.state} />
          {working ? <span className="text-[11px] text-muted-foreground">working</span> : null}
        </div>
        {project.lastError ? (
          <p
            className="mt-1 max-w-[18rem] truncate text-[11px] text-destructive"
            title={project.lastError}
          >
            {project.lastError}
          </p>
        ) : null}
      </td>
      <td className="px-4 py-3">
        <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/30 px-2 py-1 font-mono text-[11px] text-muted-foreground">
          <Database className="size-3" />
          {project.pgMajor}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <HardDrive className="size-3.5" />
            {formatBytes(project.memoryBytes)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Cpu className="size-3.5" />
            {(project.nanoCpus / 1e9).toFixed(1)} vCPU
          </span>
        </div>
      </td>
      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
        {project.hostPort ?? "—"}
      </td>
      <td
        className="px-4 py-3 text-xs text-muted-foreground"
        title={new Date(project.createdAt).toLocaleString()}
      >
        {relativeTime(project.createdAt)}
      </td>
      <td className="w-10 pr-4 text-right">
        <ArrowUpRight className="ml-auto size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </td>
    </tr>
  );
}

type ProjectFilter = "all" | "running" | "not-running";

const FILTERS: Array<{ value: ProjectFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "not-running", label: "Not running" },
];

export default function ProjectsPage() {
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProjectFilter>("all");

  const { data, isLoading, error } = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
    refetchInterval: 3000,
  });

  const projects = data?.projects ?? [];
  const runningCount = projects.filter((project) => project.state === "running").length;
  const attentionCount = projects.length - runningCount;

  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return projects.filter((project) => {
      const matchesQuery =
        !needle ||
        project.name.toLowerCase().includes(needle) ||
        project.ref.toLowerCase().includes(needle);
      const matchesFilter =
        filter === "all" ||
        (filter === "running" ? project.state === "running" : project.state !== "running");
      return matchesQuery && matchesFilter;
    });
  }, [projects, query, filter]);

  const clearFilters = () => {
    setQuery("");
    setFilter("all");
  };

  return (
    <div className="grid w-full min-w-0 gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Control plane
            <span className="text-border">/</span>
            Projects
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">Your databases</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Each project is its own Postgres container, with its own volume, credentials and
            superuser.
          </p>
        </div>
        <Button size="lg" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          New project
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Metric
          label="Projects"
          value={projects.length}
          icon={Database}
          detail="Each with its own volume"
        />
        <Metric
          label="Running"
          value={runningCount}
          icon={Activity}
          detail="Ready for connections"
        />
        <Metric
          label="Not running"
          value={attentionCount}
          icon={TriangleAlert}
          detail={attentionCount === 0 ? "Everything is up" : "Stopped, failed or in progress"}
        />
      </div>

      {isLoading ? (
        <Card className="gap-0 py-0">
          <div className="border-b px-4 py-3">
            <Skeleton className="h-4 w-28" />
          </div>
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-4 border-b px-4 py-4 last:border-0">
              <Skeleton className="size-9 rounded-lg" />
              <div className="grid gap-2">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="ml-auto h-5 w-20 rounded-full" />
              <Skeleton className="hidden h-4 w-24 sm:block" />
            </div>
          ))}
        </Card>
      ) : error ? (
        <ErrorAlert error={error} fallback="Could not load projects." title="Projects unavailable" />
      ) : (
        <Card className="gap-0 py-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium">Projects</h2>
              <Badge variant="secondary" className="tabular-nums">
                {visibleProjects.length}
              </Badge>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter by name or ref"
                  aria-label="Filter projects"
                  className="h-8 w-56 pl-8 text-xs"
                />
              </div>
              <div
                role="group"
                aria-label="Filter projects by state"
                className="flex items-center gap-0.5 rounded-lg border p-0.5"
              >
                {FILTERS.map((option) => (
                  <Button
                    key={option.value}
                    type="button"
                    size="xs"
                    variant={filter === option.value ? "secondary" : "ghost"}
                    aria-pressed={filter === option.value}
                    onClick={() => setFilter(option.value)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          {visibleProjects.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-16 text-center">
              <span className="relative flex size-16 items-center justify-center rounded-2xl border bg-muted/30">
                <Database className="size-7 text-muted-foreground" />
                <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full border bg-background text-[10px] font-medium text-muted-foreground">
                  {projects.length}
                </span>
              </span>
              <h3 className="mt-5 text-base font-semibold">
                {projects.length === 0 ? "No projects yet" : "No projects match"}
              </h3>
              <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
                {projects.length === 0
                  ? "Create one and you get a Postgres connection string in about a minute — the first project on a version has to pull the image."
                  : "Try a different name, ref, or state filter."}
              </p>
              {projects.length === 0 ? (
                <Button className="mt-5" onClick={() => setCreating(true)}>
                  <Plus className="size-4" />
                  Create your first project
                </Button>
              ) : (
                <Button className="mt-5" variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[64rem] text-sm">
                <thead className="border-b bg-muted/25 text-left text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Project</th>
                    <th className="px-4 py-2.5 font-medium">State</th>
                    <th className="px-4 py-2.5 font-medium">Version</th>
                    <th className="px-4 py-2.5 font-medium">Resources</th>
                    <th className="px-4 py-2.5 font-medium">Port</th>
                    <th className="px-4 py-2.5 font-medium">Created</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {visibleProjects.map((project) => (
                    <ProjectRow key={project.id} project={project} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {creating ? <CreateProjectDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
