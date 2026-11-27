import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./ui/button";

export function CopyButton({ value, label }: { value: string; label: string }) {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(timer);
    }, [copied]);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
        } catch {
            // Clipboard can be blocked (insecure context); nothing useful to show.
        }
    };

    return (
        <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-9 shrink-0"
            onClick={copy}
            aria-label={copied ? "Copied" : label}
            title={copied ? "Copied" : label}
        >
            {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
        </Button>
    );
}

/** Monospace block; pass `copyLabel` to add a copy button beside it. */
export function CodeBlock({ value, copyLabel }: { value: string; copyLabel?: string }) {
    return (
        <div className="flex gap-2">
            <pre className="flex-1 overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs leading-6">
                {value}
            </pre>
            {copyLabel ? <CopyButton value={value} label={copyLabel} /> : null}
        </div>
    );
}
