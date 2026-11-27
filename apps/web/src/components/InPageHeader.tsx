import type { ReactNode } from "react";

interface InPageHeaderProps {
    title: ReactNode;
    badge?: ReactNode;
    description?: ReactNode;
    actions?: ReactNode;
}

/**
 * Header shared by every project page. The single sidebar toggle lives in
 * ProjectShell, so every project page keeps project navigation reachable.
 */
export function InPageHeader({ title, badge, description, actions}: InPageHeaderProps) {
    return (
        <div className="grid gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                    <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
                    {badge}
                </div>
                {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
            </div>
            {description ? (
                <p className="text-xs text-muted-foreground">{description}</p>
            ) : null}
        </div>
    );
}
