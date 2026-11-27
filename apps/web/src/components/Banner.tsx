import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const VARIANTS = {
    muted: "text-muted-foreground",
    warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    danger: "bg-destructive/10 text-destructive",
} as const;

/** A thin full-width notice that sits between the sections of a panel. */
export function Banner({
    variant = "muted",
    children,
}: {
    variant?: keyof typeof VARIANTS;
    children: ReactNode;
}) {
    return <p className={cn("border-b px-4 py-1.5 text-xs", VARIANTS[variant])}>{children}</p>;
}
