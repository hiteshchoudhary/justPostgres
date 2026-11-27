import { NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import AccountMenu from "./AccountMenu.js";
import ThemeToggle from "./ThemeToggle.js";
import { Wordmark } from "@/components/Logo";
import { api, type AdminSummary } from "../lib/api.js";

const NAV = [
  { to: "/projects", label: "Projects" },
  { to: "/jobs", label: "Jobs" },
  { to: "/health", label: "Health" },
  { to: "/instance", label: "Instance" },
];

const STATUS_COLOR = {
  ok: "bg-ok",
  degraded: "bg-warn",
  down: "bg-danger",
  unknown: "bg-content-subtle",
} as const;

const STATUS_LABEL = {
  ok: "All systems normal",
  degraded: "Degraded — see Health",
  down: "Something is down — see Health",
  unknown: "Connecting to the control plane",
} as const;

function HealthPill({ status }: { status: keyof typeof STATUS_COLOR }) {
  return (
    <NavLink
      to="/health"
      title={STATUS_LABEL[status]}
      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        {status !== "ok" ? (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${STATUS_COLOR[status]}`}
          />
        ) : null}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${STATUS_COLOR[status]}`} />
      </span>
      <span className="sr-only">{STATUS_LABEL[status]}</span>
      {status !== "ok" ? <span className="hidden sm:inline">{status}</span> : null}
    </NavLink>
  );
}

type LayoutProps = {
  admin: AdminSummary | null;
};

export default function Layout({ admin }: LayoutProps) {
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 10_000,
  });

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface-raised focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>
      {/* Full-width app bar: brand + primary nav on the left, tools on the right. */}
      <header className="sticky top-0 z-40 h-14 shrink-0 border-b border-border bg-surface-overlay/85 backdrop-blur-md">
        <div className="flex h-full items-center gap-6 px-4">
          <NavLink to="/projects" className="flex shrink-0 items-center" aria-label="justpostgres">
            <Wordmark />
          </NavLink>

          <nav aria-label="Primary" className="min-w-0 flex-1">
            <ul className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none]">
              {NAV.map((item) => (
                <li key={item.to} className="shrink-0">
                  <NavLink
                    to={item.to}
                    className={({ isActive }) =>
                      `block rounded-md px-3 py-1.5 text-sm transition-colors ${
                        isActive
                          ? "bg-accent-soft font-medium text-accent"
                          : "text-content-muted hover:bg-surface-sunken hover:text-content"
                      }`
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>

          <div className="flex shrink-0 items-center gap-1">
            <HealthPill status={health?.status ?? "unknown"} />
            <ThemeToggle />
            {admin ? <AccountMenu admin={admin} /> : null}
          </div>
        </div>
      </header>

      {/* Below the bar: scrolling content. */}
      <div className="flex flex-1">
        <div className="flex min-w-0 flex-1 flex-col p-8 pt-4">
          <main
            id="main-content"
            tabIndex={-1}
            className="flex min-w-0 flex-1 flex-col"
          >
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
