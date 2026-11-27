import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import type { BranchNode } from "@justpostgres/shared";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { InPageHeader } from "@/components/InPageHeader";
import { Loading } from "@/components/Loading";
import { ToneBadge } from "@/components/ToneBadge";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function toLocalInputValue(ms: number): string {
  return new Date(ms - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function CreateBranchModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState<"now" | "time">("now");
  const [when, setWhen] = useState(toLocalInputValue(Date.now() - 3600_000));
  const [name, setName] = useState("");
  const [ttl, setTtl] = useState(24);

  const targetTime = from === "time" ? new Date(when).getTime() : undefined;

  // The plan is fetched for the exact request being composed, because the two
  // strategies differ by orders of magnitude and the reason is not something a
  // user should have to infer from how long it took.
  const { data: plan } = useQuery({
    queryKey: ["branch-plan", projectId, targetTime ?? "now"],
    queryFn: () => api.branchPlan(projectId, targetTime),
  });

  const create = useMutation({
    mutationFn: () =>
      api.createBranch(projectId, {
        ...(targetTime !== undefined ? { targetTime } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        ttlHours: ttl,
      }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["branches", projectId] });
      onClose();
      navigate(`/projects/${data.project.id}`);
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New branch</DialogTitle>
          <DialogDescription>
            A full, independent copy of this project that you can break freely.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-1">
            {(["now", "time"] as const).map((option) => (
              <button
                key={option}
                onClick={() => setFrom(option)}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  from === option
                    ? "bg-surface-sunken font-medium text-content"
                    : "text-content-muted hover:text-content"
                }`}
              >
                {option === "now" ? "From right now" : "From a point in time"}
              </button>
            ))}
          </div>

          {from === "time" ? (
            <div className="space-y-1.5">
              <Label htmlFor="branch-point" className="text-xs font-medium text-content-muted">
                Branch point
              </Label>
              <Input
                id="branch-point"
                type="datetime-local"
                step={1}
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
            </div>
          ) : null}

          {plan ? (
            <div
              className={`rounded-md px-3 py-2 text-xs ${
                plan.plan.method === "cow" ? "bg-ok/10 text-ok" : "bg-surface-sunken text-content-muted"
              }`}
            >
              <span className="font-medium">
                {plan.plan.method === "cow" ? "Copy-on-write" : "Point-in-time restore"}
              </span>
              <span className="mt-0.5 block">{plan.plan.reason}</span>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="branch-name" className="text-xs font-medium text-content-muted">
              Name
            </Label>
            <Input
              id="branch-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="auto"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="branch-ttl" className="text-xs font-medium text-content-muted">
              Delete automatically after
            </Label>
            <Select value={String(ttl)} onValueChange={(v) => setTtl(Number(v))}>
              <SelectTrigger id="branch-ttl" aria-describedby="branch-ttl-hint">
                <SelectValue>
                  {ttl === 0 ? "Never" : ttl === 1 ? "1 hour" : ttl === 24 ? "1 day" : "1 week"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1 hour</SelectItem>
                <SelectItem value="24">1 day</SelectItem>
                <SelectItem value="168">1 week</SelectItem>
                <SelectItem value="0">Never — keep it until I delete it</SelectItem>
              </SelectContent>
            </Select>
            <p id="branch-ttl-hint" className="text-xs text-content-subtle">
              Branches are made to be thrown away. The ones nobody throws away are the ones that quietly fill a host.
            </p>
          </div>

          {create.error ? (
            <p className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
              {create.error instanceof ApiError ? create.error.message : "Could not create the branch."}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {create.isPending ? "Creating…" : "Create branch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TreeRow({
  node,
  depth,
  currentId,
  onPin,
}: {
  node: BranchNode;
  depth: number;
  currentId: string;
  onPin: (id: string, ttlHours: number | null) => void;
}) {
  const { project } = node;
  const isCurrent = project.id === currentId;
  const expiring = node.expiresAt !== null;

  return (
    <>
      <tr className={`border-b border-border last:border-0 ${isCurrent ? "bg-surface-sunken/50" : ""}`}>
        <td className="px-4 py-2.5">
          <span style={{ paddingLeft: `${depth * 16}px` }} className="inline-flex items-baseline gap-2">
            {depth > 0 ? <span className="text-content-subtle">└</span> : null}
            <Link to={`/projects/${project.id}`} className="font-medium hover:text-accent">
              {project.name}
            </Link>
            <span className="mono text-xs text-content-subtle">{project.ref}</span>
          </span>
        </td>
        <td className="px-4 py-2.5">
          {node.method ? (
            <ToneBadge tone={node.method === "cow" ? "ok" : "neutral"}>
              {node.method === "cow" ? "copy-on-write" : "point-in-time"}
            </ToneBadge>
          ) : (
            <span className="text-xs text-content-subtle">root</span>
          )}
        </td>
        <td className="px-4 py-2.5 text-xs text-content-muted">
          {project.branchPoint ? relativeTime(project.branchPoint) : "—"}
        </td>
        <td className="px-4 py-2.5 text-xs">
          {expiring ? (
            <span className="text-warn">deleted {relativeTime(node.expiresAt)}</span>
          ) : (
            <span className="text-content-subtle">pinned</span>
          )}
        </td>
        <td className="px-4 py-2.5 text-right">
          {project.parentProjectId ? (
            <button
              onClick={() => onPin(project.id, expiring ? null : 24)}
              className="text-xs text-content-muted hover:text-content"
            >
              {expiring ? "Keep" : "Expire in 24h"}
            </button>
          ) : null}
        </td>
      </tr>
      {node.children.map((child) => (
        <TreeRow key={child.project.id} node={child} depth={depth + 1} currentId={currentId} onPin={onPin} />
      ))}
    </>
  );
}

export default function BranchesPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["branches", id],
    queryFn: () => api.branches(id),
    refetchInterval: 5000,
  });

  const setExpiry = useMutation({
    mutationFn: ({ projectId, ttlHours }: { projectId: string; ttlHours: number | null }) =>
      api.setBranchExpiry(projectId, ttlHours),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["branches", id] }),
  });

  return (
    <>
      <InPageHeader
        title="Branches"
        description="A branch is a full, independent copy — its own container, its own backups, its own connection string. Break it freely; the parent never notices."
        actions={<Button onClick={() => setCreating(true)}>New branch</Button>}
      />

      {isLoading ? (
        <Loading rows={3} />
      ) : error || !data ? (
        <Card className="gap-0 py-0 px-6 py-14 text-center text-sm text-danger">
          {error instanceof ApiError ? error.message : "Could not load the branch tree."}
        </Card>
      ) : (
        <Card className="gap-0 py-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-content-subtle">
              <tr>
                <th className="px-4 py-2.5 font-medium">Project</th>
                <th className="px-4 py-2.5 font-medium">Made by</th>
                <th className="px-4 py-2.5 font-medium">Branch point</th>
                <th className="px-4 py-2.5 font-medium">Lifetime</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              <TreeRow
                node={data.tree}
                depth={0}
                currentId={id}
                onPin={(projectId, ttlHours) => setExpiry.mutate({ projectId, ttlHours })}
              />
            </tbody>
          </table>
        </Card>
      )}

      {creating ? <CreateBranchModal projectId={id} onClose={() => setCreating(false)} /> : null}
    </>
  );
}
