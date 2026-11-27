import { NavLink, useLocation, useParams } from "react-router-dom";
import {
    ArrowUpCircle,
    DatabaseBackup,
    GitBranch,
    LayoutDashboard,
    Puzzle,
    SquareTerminal,
    Table2,
    Webhook,
    type LucideIcon,
} from "lucide-react";
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarSeparator,
    useSidebar,
} from "./ui/sidebar";

interface NavItem {
    to: string;
    label: string;
    icon: LucideIcon;
    end?: boolean;
}

interface NavGroup {
    label: string;
    items: NavItem[];
}

interface ProjectTabsProps {
    projectName?: string;
}

// Grouped by what people are doing: look around, work with the database,
// connect to it, then maintain it.
const GROUPS: NavGroup[] = [
    {
        label: "Project",
        items: [{ to: "", label: "Overview", icon: LayoutDashboard, end: true }],
    },
    {
        label: "Database",
        items: [
            { to: "/data", label: "Data", icon: Table2 },
            { to: "/sql", label: "SQL", icon: SquareTerminal },
            { to: "/branches", label: "Branches", icon: GitBranch },
            { to: "/extensions", label: "Extensions", icon: Puzzle },
            { to: "/backups", label: "Backups", icon: DatabaseBackup },
        ],
    },
    {
        label: "Connect",
        items: [{ to: "/api", label: "API", icon: Webhook }],
    },
    {
        label: "Maintenance",
        items: [{ to: "/upgrade", label: "Version", icon: ArrowUpCircle }],
    },
];

function initials(name: string): string {
    return (
        name
            .split(/[\s\-_]+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part.charAt(0).toUpperCase())
            .join("") || "P"
    );
}

export default function ProjectTabs({ projectName }: ProjectTabsProps) {
    const { id = "" } = useParams<{ id: string }>();
    const { pathname } = useLocation();
    const { setOpenMobile } = useSidebar();
    const base = `/projects/${id}`;
    const name = projectName || `Project ${id}`;

    const isActive = (item: NavItem): boolean => {
        const href = `${base}${item.to}`;
        return item.end
            ? pathname === href
            : pathname === href || pathname.startsWith(`${href}/`);
    };

    return (
        <Sidebar
            collapsible="icon"
            className="top-14! h-[calc(100svh-3.5rem)]!"
        >
            <SidebarHeader className="px-3 pt-4 pb-3 group-data-[collapsible=icon]:p-2">
                <div className="flex items-center gap-3 rounded-lg px-2 py-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0">
                    <div
                        role="img"
                        aria-label={name}
                        title={name}
                        className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground group-data-[collapsible=icon]:size-8"
                    >
                        {initials(name)}
                    </div>
                    <div className="min-w-0 leading-tight group-data-[collapsible=icon]:hidden">
                        <p className="truncate text-sm font-semibold" title={name}>
                            {name}
                        </p>
                        <p
                            className="truncate text-xs text-muted-foreground"
                            title={id}
                        >
                            {id}
                        </p>
                    </div>
                </div>
            </SidebarHeader>

            <SidebarSeparator className="mx-0" />

            <SidebarContent className="scroll-thin px-1 py-2">
                <nav aria-label="Project navigation" className="flex min-h-0 flex-1 flex-col">
                    {GROUPS.map((group) => (
                        <SidebarGroup key={group.label}>
                            <SidebarGroupLabel className="text-xs font-medium text-muted-foreground">
                                {group.label}
                            </SidebarGroupLabel>
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    {group.items.map((item) => {
                                        const active = isActive(item);
                                        const Icon = item.icon;
                                        return (
                                            <SidebarMenuItem key={item.label}>
                                                <SidebarMenuButton
                                                    render={
                                                        <NavLink
                                                            to={`${base}${item.to}`}
                                                            end={item.end ?? false}
                                                            onClick={() => setOpenMobile(false)}
                                                        />
                                                    }
                                                    isActive={active}
                                                    tooltip={item.label}
                                                    className="h-9 gap-3 data-[active=true]:font-medium"
                                                >
                                                    <Icon
                                                        className={`size-4 ${
                                                            active
                                                                ? "text-primary"
                                                                : "text-muted-foreground"
                                                        }`}
                                                    />
                                                    <span>{item.label}</span>
                                                </SidebarMenuButton>
                                            </SidebarMenuItem>
                                        );
                                    })}
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </SidebarGroup>
                    ))}
                </nav>
            </SidebarContent>
        </Sidebar>
    );
}
