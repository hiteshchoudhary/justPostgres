import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import CodeMirror from "@uiw/react-codemirror";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import {
    Activity,
    Braces,
    CornerDownLeft,
    Download,
    Loader2,
    Play,
    Rows3,
    SquareTerminal,
    Terminal,
    TriangleAlert,
} from "lucide-react";
import type {
    CellValue,
    DestructiveWarning,
    ExplainOutcome,
    QueryOutcome,
    StatementResult,
} from "@justpostgres/shared";
import { Banner } from "../components/Banner";
import { CopyButton } from "../components/CopyButton";
import { ErrorAlert } from "../components/ErrorAlert";
import { InPageHeader } from "../components/InPageHeader";
import { downloadCsv, toCsv } from "../components/DataGrid.js";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
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
import { Separator } from "../components/ui/separator";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "../components/ui/tabs";
import { api } from "../lib/api.js";

const STARTER_SQL =
    "select * from information_schema.tables\nwhere table_schema = 'public'\nlimit 20;";

const SNIPPETS = [
    { label: "Tables", sql: STARTER_SQL },
    { label: "Version", sql: "select version();" },
    {
        label: "Activity",
        sql: "select pid, usename, state, query\nfrom pg_stat_activity\nwhere backend_type = 'client backend'\norder by pid\nlimit 20;",
    },
];

const STATUS_DOT = {
    ready: "bg-content-subtle",
    executing: "bg-accent",
    planned: "bg-accent",
    complete: "bg-ok",
    failed: "bg-danger",
} as const;

function useIsDark() {
    const [dark, setDark] = useState(() =>
        document.documentElement.classList.contains("dark"),
    );

    useEffect(() => {
        const root = document.documentElement;
        const sync = () => setDark(root.classList.contains("dark"));
        sync();
        const observer = new MutationObserver(sync);
        observer.observe(root, {
            attributes: true,
            attributeFilter: ["class", "data-theme"],
        });
        return () => observer.disconnect();
    }, []);

    return dark;
}
const editorChrome = (isDark: boolean) =>
    Prec.highest(
        EditorView.theme(
            {
                "&": {
                    backgroundColor: "var(--card)",
                    color: "var(--foreground)",
                    fontSize: "13px",
                },
                ".cm-scroller": {
                    fontFamily:
                        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                    lineHeight: "1.75",
                },
                ".cm-content": {
                    padding: "12px 0",
                    caretColor: "var(--primary)",
                },
                ".cm-gutters": {
                    backgroundColor: "var(--card)",
                    color: "var(--muted-foreground)",
                    borderRight: "1px solid var(--border)",
                },
                ".cm-lineNumbers .cm-gutterElement": {
                    padding: "0 14px 0 16px",
                },
                ".cm-activeLine": {
                    backgroundColor:
                        "color-mix(in oklch, var(--primary) 8%, transparent)",
                },
                ".cm-activeLineGutter": {
                    backgroundColor: "transparent",
                    color: "var(--foreground)",
                },
                ".cm-cursor, .cm-dropCursor": {
                    borderLeftColor: "var(--primary)",
                    borderLeftWidth: "2px",
                },
                "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
                    {
                        backgroundColor:
                            "color-mix(in oklch, var(--primary) 25%, transparent)",
                    },
                ".cm-tooltip": {
                    backgroundColor: "var(--popover)",
                    color: "var(--popover-foreground)",
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                    boxShadow: "0 8px 24px rgb(0 0 0 / 0.15)",
                },
                ".cm-tooltip-autocomplete ul li[aria-selected]": {
                    backgroundColor: "var(--primary)",
                    color: "var(--primary-foreground)",
                },
            },
            { dark: isDark },
        ),
    );

function ResultTable({ result }: { result: StatementResult }) {
    const columns = result.fields.map((field) => field.name);

    if (columns.length === 0) {
        return (
            <div className="flex flex-wrap items-center gap-2.5 px-4 py-6 text-xs text-muted-foreground">
                <span className="size-1.5 rounded-full bg-ok" />
                <span className="font-mono font-medium text-foreground">
                    {(result.command ?? "OK").toUpperCase()}
                </span>
                <span className="text-border">/</span>
                <span>
                    {result.rowCount ?? 0} row{result.rowCount === 1 ? "" : "s"}{" "}
                    affected
                </span>
                <span className="text-border">/</span>
                <span className="font-mono">{result.durationMs}ms</span>
            </div>
        );
    }

    return (
        <div className="scroll-thin max-h-[min(52vh,520px)] overflow-auto">
            <table className="w-full caption-bottom border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-surface-overlay/95 backdrop-blur-sm">
                    <tr className="border-b border-border">
                        <th
                            scope="col"
                            aria-label="Row number"
                            className="w-10 border-r border-border/60 px-3 py-2 text-right font-mono text-[10px] font-normal text-content-subtle"
                        >
                            #
                        </th>
                        {columns.map((name) => (
                            <th
                                key={name}
                                scope="col"
                                className="mono whitespace-nowrap px-3 py-2 text-left font-medium text-content-muted"
                            >
                                {name}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {result.rows.map((row, index) => (
                        <tr
                            key={index}
                            className="border-b border-border/60 transition-colors last:border-0 hover:bg-accent-soft/40"
                        >
                            <td className="select-none border-r border-border/60 px-3 py-1.5 text-right font-mono text-[10px] text-content-subtle">
                                {index + 1}
                            </td>
                            {columns.map((name) => {
                                const value: CellValue | undefined = row[name];
                                const numeric =
                                    value != null &&
                                    value !== "" &&
                                    !Number.isNaN(Number(value));
                                return (
                                    <td
                                        key={name}
                                        title={value ?? undefined}
                                        className={`mono max-w-[28rem] truncate px-3 py-1.5 align-top ${
                                            numeric
                                                ? "text-right tabular-nums"
                                                : ""
                                        }`}
                                    >
                                        {value == null ? (
                                            <span className="italic text-content-subtle">
                                                NULL
                                            </span>
                                        ) : (
                                            value
                                        )}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
            {result.rows.length === 0 ? (
                <p className="px-4 py-8 text-center text-xs text-muted-foreground">
                    Query returned no rows.
                </p>
            ) : null}
        </div>
    );
}

function ConfirmDestructive({
    warnings,
    onCancel,
    onConfirm,
}: {
    warnings: DestructiveWarning[];
    onCancel: () => void;
    onConfirm: () => void;
}) {
    return (
        <Dialog open onOpenChange={(open) => (!open ? onCancel() : undefined)}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <div className="mb-1 grid size-9 place-items-center rounded-lg bg-destructive/10 text-destructive">
                        <TriangleAlert className="size-4" />
                    </div>
                    <DialogTitle>Confirm destructive statements</DialogTitle>
                    <DialogDescription>
                        These statements can change data without a limiting
                        clause. Review them before running.
                    </DialogDescription>
                </DialogHeader>
                <ul className="scroll-thin max-h-52 space-y-2 overflow-auto">
                    {warnings.map((warning, index) => (
                        <li
                            key={index}
                            className="rounded-lg border border-border bg-muted/50 p-3"
                        >
                            <pre className="mono overflow-x-auto text-[11px] leading-5 text-foreground">
                                {warning.statement}
                            </pre>
                            <p className="mt-2 text-xs text-destructive">
                                {warning.reason}
                            </p>
                        </li>
                    ))}
                </ul>
                <DialogFooter>
                    <Button variant="outline" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button variant="destructive" onClick={onConfirm}>
                        <Play className="size-3.5" />
                        Run anyway
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export default function SqlPage() {
    const { id = "" } = useParams();
    const [text, setText] = useState(STARTER_SQL);
    const [outcome, setOutcome] = useState<QueryOutcome | null>(null);
    const [explain, setExplain] = useState<ExplainOutcome | null>(null);
    const [activeTab, setActiveTab] = useState("0");
    const [pendingConfirm, setPendingConfirm] = useState<
        DestructiveWarning[] | null
    >(null);
    const isDark = useIsDark();

    const { data: schema } = useQuery({
        queryKey: ["schema", id],
        queryFn: () => api.schema(id),
        staleTime: 60_000,
    });

    const run = useMutation({
        mutationFn: (confirmed: boolean) =>
            api.runQuery(id, { sql: text, confirmed }),
        onSuccess: (data) => {
            setExplain(null);
            if (data.requiresConfirmation) {
                setPendingConfirm(data.requiresConfirmation);
                return;
            }
            setPendingConfirm(null);
            setActiveTab("0");
            setOutcome(data);
        },
    });

    const explainQuery = useMutation({
        mutationFn: (analyze: boolean) => api.explain(id, text, analyze),
        onSuccess: (data) => {
            setOutcome(null);
            setExplain(data);
        },
    });

    const runMutate = run.mutate;
    const explainMutate = explainQuery.mutate;
    const runNow = useCallback(() => runMutate(false), [runMutate]);
    const explainNow = useCallback(
        (analyze: boolean) => explainMutate(analyze),
        [explainMutate],
    );

    const extensions = useMemo(() => {
        const tables: Record<string, string[]> = {};
        for (const s of schema?.schemas ?? []) {
            for (const relation of s.relations) {
                const key =
                    s.name === "public"
                        ? relation.name
                        : `${s.name}.${relation.name}`;
                tables[key] = [];
            }
        }

        return [
            sql({
                dialect: PostgreSQL,
                schema: tables,
                upperCaseKeywords: false,
            }),
            EditorView.lineWrapping,
            editorChrome(isDark),
            Prec.highest(
                keymap.of([
                    {
                        key: "Mod-Enter",
                        run: () => {
                            runNow();
                            return true;
                        },
                    },
                    {
                        key: "Mod-Shift-Enter",
                        run: () => {
                            explainNow(true);
                            return true;
                        },
                    },
                ]),
            ),
        ];
    }, [schema, runNow, explainNow, isDark]);

    const error = run.error ?? explainQuery.error;
    const busy = run.isPending || explainQuery.isPending;
    const objectCount = (schema?.schemas ?? []).reduce(
        (total, s) => total + s.relations.length,
        0,
    );
    const status = busy
        ? "executing"
        : error
          ? "failed"
          : outcome
            ? "complete"
            : explain
              ? "planned"
              : "ready";
    const lineCount = text.trim() === "" ? 0 : text.split("\n").length;

    return (
        <div className="grid min-w-0 gap-4 pb-8">
            <InPageHeader
                title="SQL console"
                badge={
                    <Badge
                        variant="outline"
                        className="font-mono text-[10px] tracking-wider text-muted-foreground"
                    >
                        POSTGRES
                    </Badge>
                }
                description="A direct line to this database. Statements run in order; results, plans and errors appear below."
            />

            <Card className="relative gap-0 overflow-visible py-0 shadow-raised ring-border duration-300 animate-in fade-in-0 slide-in-from-bottom-2">
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-accent/70 to-transparent"
                />
                <div className="relative flex flex-wrap items-center justify-between gap-3 rounded-t-xl border-b border-border bg-surface-overlay/70 px-4 py-2.5">
                    <div className="flex min-w-0 items-center gap-2.5">
                        <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-accent/20 bg-accent-soft text-accent">
                            <SquareTerminal className="size-4" />
                        </div>
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-medium">
                                    Editor
                                </span>
                                <span className="hidden font-mono text-[10px] uppercase tracking-[0.12em] text-content-subtle sm:inline">
                                    query.sql
                                </span>
                            </div>
                            <p className="text-[11px] text-muted-foreground">
                                Schema-aware completion · multi-statement
                            </p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                            variant="ghost"
                            size="sm"
                            disabled={!text.trim() || busy}
                            onClick={() => explainQuery.mutate(false)}
                        >
                            <Braces className="size-3.5 text-muted-foreground" />
                            Explain
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            disabled={!text.trim() || busy}
                            onClick={() => explainQuery.mutate(true)}
                        >
                            <Activity className="size-3.5 text-muted-foreground" />
                            Analyze
                        </Button>
                        <Separator
                            orientation="vertical"
                            className="mx-1 h-5"
                        />
                        <Button
                            size="sm"
                            className="min-w-[4.5rem] shadow-card"
                            disabled={!text.trim() || busy}
                            onClick={() => run.mutate(false)}
                        >
                            {run.isPending ? (
                                <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                                <Play className="size-3.5 fill-current" />
                            )}
                            {run.isPending ? "Running" : "Run"}
                        </Button>
                    </div>
                </div>

                <CodeMirror
                    value={text}
                    onChange={setText}
                    extensions={extensions}
                    height="264px"
                    theme={isDark ? "dark" : "light"}
                    placeholder="-- write SQL here"
                    className="scroll-thin"
                    basicSetup={{
                        lineNumbers: true,
                        foldGutter: false,
                        highlightActiveLine: true,
                        highlightActiveLineGutter: true,
                        bracketMatching: true,
                        autocompletion: true,
                    }}
                />

                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-b-xl border-t border-border bg-muted/40 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span
                            role="status"
                            className="inline-flex items-center gap-1.5"
                        >
                            <span
                                className={`size-1.5 rounded-full ${STATUS_DOT[status]} ${busy ? "animate-pulse" : ""}`}
                            />
                            {status}
                        </span>
                        <span>{lineCount} lines</span>
                        <span>{objectCount} objects</span>
                    </div>
                    <span className="inline-flex items-center gap-1 normal-case tracking-normal">
                        <CornerDownLeft className="size-3" />
                        Cmd/Ctrl + Enter to run · Shift for analyze
                    </span>
                </div>
            </Card>

            {error ? (
                <ErrorAlert
                    error={error}
                    title="Request failed"
                    fallback="The query could not be sent."
                />
            ) : null}

            {!outcome && !explain && !error ? (
                <Card className="gap-0 py-0 duration-300 animate-in fade-in-0 slide-in-from-bottom-2 [animation-delay:60ms]">
                    <div className="flex flex-col items-center justify-center gap-5 px-6 py-14 text-center">
                        <div className="relative">
                            <div className="absolute -inset-4 rounded-2xl bg-accent/8 blur-2xl" />
                            <div className="relative grid size-12 place-items-center rounded-xl border border-border bg-muted text-accent ring-4 ring-card">
                                <Terminal className="size-5" />
                            </div>
                        </div>
                        <div className="grid gap-1.5">
                            <p className="text-sm font-medium">
                                Ready when you are
                            </p>
                            <p className="mx-auto max-w-md text-xs leading-relaxed text-muted-foreground">
                                Run the editor to see rows here. Each statement
                                gets its own tab, and plans and errors render
                                alongside the results.
                            </p>
                        </div>
                        <div className="flex flex-wrap items-center justify-center gap-2">
                            <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-content-subtle">
                                Try
                            </span>
                            {SNIPPETS.map((snippet) => (
                                <Button
                                    key={snippet.label}
                                    variant="outline"
                                    size="xs"
                                    className="font-mono"
                                    onClick={() => setText(snippet.sql)}
                                >
                                    {snippet.label}
                                </Button>
                            ))}
                        </div>
                    </div>
                </Card>
            ) : null}

            {explain ? (
                <Card className="gap-0 overflow-hidden py-0 duration-300 animate-in fade-in-0 slide-in-from-bottom-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2">
                        <div className="flex items-center gap-2">
                            <Braces className="size-3.5 text-accent" />
                            <span className="text-xs font-medium">
                                Query plan
                            </span>
                            <Badge
                                variant="secondary"
                                className="font-mono text-[10px]"
                            >
                                {explain.durationMs}ms
                            </Badge>
                        </div>
                        <CopyButton value={explain.text} label="Copy plan" />
                    </div>
                    <pre className="mono scroll-thin max-h-[50vh] overflow-auto whitespace-pre px-4 py-3 text-[11px] leading-6 text-content-muted">
                        {explain.text}
                    </pre>
                </Card>
            ) : null}

            {outcome?.error ? (
                <Alert variant="destructive" className="px-4 py-3">
                    <TriangleAlert className="size-4" />
                    <AlertTitle>Postgres rejected the statement</AlertTitle>
                    <AlertDescription className="font-mono text-xs">
                        <p className="break-words">{outcome.error.message}</p>
                        {outcome.error.detail ? (
                            <p className="mt-1.5 break-words text-muted-foreground">
                                {outcome.error.detail}
                            </p>
                        ) : null}
                        {outcome.error.hint ? (
                            <p className="mt-1.5 break-words text-muted-foreground">
                                Hint: {outcome.error.hint}
                            </p>
                        ) : null}
                        {outcome.error.statement ? (
                            <pre className="mono mt-2 overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 text-[11px] text-foreground">
                                {outcome.error.statement}
                            </pre>
                        ) : null}
                    </AlertDescription>
                </Alert>
            ) : null}

            {outcome && outcome.results.length > 0 ? (
                <Card className="gap-0 overflow-hidden py-0 duration-300 animate-in fade-in-0 slide-in-from-bottom-2">
                    <Tabs
                        value={activeTab}
                        onValueChange={setActiveTab}
                        className="gap-0"
                    >
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2">
                            <TabsList variant="line" className="h-auto gap-1">
                                {outcome.results.map((result, index) => (
                                    <TabsTrigger
                                        key={index}
                                        value={String(index)}
                                        className="h-7 gap-1.5 px-2 font-mono text-[11px] data-[active]:after:bg-accent"
                                    >
                                        <span className="text-[10px] text-content-subtle">
                                            {String(index + 1).padStart(2, "0")}
                                        </span>
                                        <span>
                                            {(
                                                result.command ?? "QUERY"
                                            ).toUpperCase()}
                                        </span>
                                    </TabsTrigger>
                                ))}
                            </TabsList>
                            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wide text-content-subtle">
                                <Rows3 className="size-3" />
                                {outcome.results.length} statement
                                {outcome.results.length === 1 ? "" : "s"} ·{" "}
                                {outcome.totalDurationMs}ms
                            </div>
                        </div>

                        {outcome.results.map((result, index) => (
                            <TabsContent
                                key={index}
                                value={String(index)}
                                className="mt-0"
                            >
                                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
                                    <div className="flex flex-wrap items-center gap-2.5 font-mono text-[11px] text-muted-foreground">
                                        <Badge
                                            variant="secondary"
                                            className="font-mono text-[10px]"
                                        >
                                            {(
                                                result.command ?? "STATEMENT"
                                            ).toUpperCase()}
                                        </Badge>
                                        <span>
                                            {result.rowCount ?? 0} row
                                            {result.rowCount === 1 ? "" : "s"}
                                        </span>
                                        <span className="text-border">·</span>
                                        <span>{result.durationMs}ms</span>
                                    </div>
                                    {result.fields.length > 0 ? (
                                        <Button
                                            variant="outline"
                                            size="xs"
                                            onClick={() =>
                                                downloadCsv(
                                                    `result-${index + 1}.csv`,
                                                    toCsv(
                                                        result.fields.map(
                                                            (field) =>
                                                                field.name,
                                                        ),
                                                        result.rows,
                                                    ),
                                                )
                                            }
                                        >
                                            <Download className="size-3" />
                                            CSV
                                        </Button>
                                    ) : null}
                                </div>
                                {result.truncated ? (
                                    <Banner variant="warning">
                                        Showing the first {result.rows.length}{" "}
                                        rows of {result.rowCount}. Export to CSV
                                        or add a LIMIT to see the rest.
                                    </Banner>
                                ) : null}
                                <ResultTable result={result} />
                            </TabsContent>
                        ))}
                    </Tabs>
                </Card>
            ) : null}

            {pendingConfirm ? (
                <ConfirmDestructive
                    warnings={pendingConfirm}
                    onCancel={() => setPendingConfirm(null)}
                    onConfirm={() => {
                        setPendingConfirm(null);
                        run.mutate(true);
                    }}
                />
            ) : null}
        </div>
    );
}
