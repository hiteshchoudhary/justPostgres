import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";

export const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-transparent bg-surface-sunken text-content-muted",
  ok: "border-transparent bg-ok/12 text-ok",
  warn: "border-transparent bg-warn/12 text-warn",
  danger: "border-transparent bg-danger/12 text-danger",
  accent: "border-transparent bg-accent/12 text-accent",
};

export const DOT_CLASS: Record<Tone, string> = {
  neutral: "bg-content-subtle",
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  accent: "bg-accent",
};

export function StateDot({
  tone,
  pulse = false,
  className,
}: {
  tone: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        DOT_CLASS[tone],
        pulse ? "animate-pulse" : "",
        className,
      )}
    />
  );
}

export function ToneBadge({
  tone = "neutral",
  dot = false,
  pulse = false,
  className,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Badge variant="outline" className={cn("gap-1.5", TONE_CLASS[tone], className)}>
      {dot ? <StateDot tone={tone} pulse={pulse} /> : null}
      {children}
    </Badge>
  );
}
