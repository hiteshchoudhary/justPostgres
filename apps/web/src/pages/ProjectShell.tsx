import { Link, Outlet, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import ProjectTabs from "../components/ProjectTabs.js";
import { api, ApiError } from "../lib/api.js";
import { Loading } from "@/components/Loading";
import { StateBadge } from "@/components/StateBadge.js";
import { Card } from "@/components/ui/card";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar.js";

/**
 * Shared chrome for a project: identity, state and the tab bar, so switching
 * between Overview, Data and SQL does not reload the header or lose the sense
 * of which project you are in.
 */
export default function ProjectShell() {
  const { id = "" } = useParams();

  const { data, isLoading, error } = useQuery({
    queryKey: ["project", id],
    queryFn: () => api.getProject(id),
    refetchInterval: 5000,
  });

  if (isLoading) {
    return <Loading rows={2} />;
  }
  if (error || !data) {
    return (
      <Card className="gap-0 px-6 py-14 text-center text-sm text-destructive">
        {error instanceof ApiError ? error.message : "Could not load this project."}
      </Card>
    );
  }

  const { project } = data;

  return (
    <SidebarProvider>
      <ProjectTabs projectName={project.name} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-14 z-30 -mx-8 mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface-overlay/90 px-8 py-2 backdrop-blur-md">
          <SidebarTrigger className="-ml-1" />
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              to="/projects"
              className="shrink-0 text-xs text-muted-foreground hover:text-content"
            >
              ← Projects
            </Link>
            <span className="truncate text-sm font-semibold">{project.name}</span>
            <StateBadge state={project.state} />
            <span className="mono truncate text-xs text-muted-foreground">
              {project.ref} · Postgres {project.pgMajor}
            </span>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet context={{ project }} />
        </div>
      </div>
    </SidebarProvider>
  );
}
