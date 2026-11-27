import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Download, Plus, RefreshCw, Table2 } from "lucide-react";
import type { CellValue, Filter } from "@justpostgres/shared";
import DataGrid, { downloadCsv, toCsv } from "../components/DataGrid.js";
import SchemaSidebar from "../components/SchemaSidebar.js";
import { Banner } from "../components/Banner";
import { ErrorAlert } from "../components/ErrorAlert";
import { FilterBar } from "../components/FilterBar";
import { InsertRowDialog } from "../components/InsertRowDialog";
import { InPageHeader } from "../components/InPageHeader.js";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { api } from "../lib/api.js";
import { errorMessage } from "../lib/errors";

const PAGE_SIZE = 50;

interface Selection {
    schema: string;
    table: string;
}

export default function DataPage() {
    const { id = "" } = useParams();
    const queryClient = useQueryClient();

    const [selection, setSelection] = useState<Selection | null>(null);
    const [sort, setSort] = useState<{ column: string; direction: "asc" | "desc" } | undefined>();
    const [filters, setFilters] = useState<Filter[]>([]);
    const [cursors, setCursors] = useState<string[]>([]);
    const [inserting, setInserting] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

    const cursor = cursors[cursors.length - 1];
    const page = cursors.length;

    // Changing table, sort or filters invalidates the cursor stack: a cursor
    // encodes a position in one specific ordering.
    useEffect(() => {
        setCursors([]);
    }, [selection?.schema, selection?.table, sort?.column, sort?.direction, filters]);

    const browse = useQuery({
        queryKey: ["browse", id, selection, sort, filters, cursor],
        queryFn: () =>
            api.browse(id, {
                schema: selection!.schema,
                table: selection!.table,
                limit: PAGE_SIZE,
                ...(sort ? { sort } : {}),
                ...(filters.length > 0 ? { filters } : {}),
                ...(cursor ? { cursor } : {}),
                countMode: filters.length > 0 ? "exact" : "estimate",
            }),
        enabled: selection !== null,
        placeholderData: (previous) => previous,
    });

    const result = browse.data;
    const columnNames = useMemo(() => result?.columns.map((c) => c.name) ?? [], [result]);

    const refresh = () => void queryClient.invalidateQueries({ queryKey: ["browse", id] });

    const primaryKeyOf = (rowIndex: number) => {
        const row = result!.rows[rowIndex]!;
        const key: Record<string, CellValue> = {};
        for (const pk of result!.primaryKey) key[pk] = row[pk] ?? null;
        return key;
    };

    const editCell = useMutation({
        mutationFn: async ({
            rowIndex,
            column,
            value,
        }: {
            rowIndex: number;
            column: string;
            value: CellValue;
        }) =>
            api.updateRow(id, selection!.schema, selection!.table, primaryKeyOf(rowIndex), {
                [column]: value,
            }),
        onSuccess: () => {
            setActionError(null);
            refresh();
        },
        onError: (err) => setActionError(errorMessage(err, "Update failed.")),
    });

    const removeRow = useMutation({
        mutationFn: async (rowIndex: number) =>
            api.deleteRow(id, selection!.schema, selection!.table, primaryKeyOf(rowIndex)),
        onSuccess: () => {
            setActionError(null);
            refresh();
        },
        onError: (err) => setActionError(errorMessage(err, "Delete failed.")),
    });

    const toggleSort = (column: string) => {
        setSort((current) =>
            current?.column === column
                ? current.direction === "asc"
                    ? { column, direction: "desc" }
                    : undefined
                : { column, direction: "asc" },
        );
    };

    return (
        <div className="grid w-full min-w-0 gap-4">
            <InPageHeader title="Data" description="Browse and edit the tables in this database." />

            <div className="flex h-[calc(100vh-15rem)] overflow-hidden rounded-lg border bg-card">
                <SchemaSidebar projectId={id} selected={selection} onSelect={setSelection} />

                <section className="flex min-w-0 flex-1 flex-col">
                    {!selection ? (
                        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                            <Table2 className="size-8 opacity-40" />
                            Pick a table to browse.
                        </div>
                    ) : (
                        <>
                            <header className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
                                <div className="min-w-0">
                                    <span className="font-mono text-sm font-medium">
                                        {selection.schema}.{selection.table}
                                    </span>
                                    {result?.total ? (
                                        <span className="ml-2 text-xs text-muted-foreground">
                                            {result.total.mode === "estimate" ? "~" : ""}
                                            {result.total.value.toLocaleString()} rows
                                        </span>
                                    ) : null}
                                </div>
                                <div className="flex shrink-0 gap-2">
                                    <Button variant="outline" size="sm" onClick={refresh}>
                                        <RefreshCw className="size-4" />
                                        Refresh
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={!result}
                                        onClick={() =>
                                            result &&
                                            downloadCsv(
                                                `${selection.table}.csv`,
                                                toCsv(columnNames, result.rows),
                                            )
                                        }
                                    >
                                        <Download className="size-4" />
                                        Export CSV
                                    </Button>
                                    <Button
                                        size="sm"
                                        disabled={!result?.editable}
                                        onClick={() => setInserting(true)}
                                    >
                                        <Plus className="size-4" />
                                        Insert row
                                    </Button>
                                </div>
                            </header>

                            <FilterBar columns={columnNames} filters={filters} onChange={setFilters} />

                            {result && !result.editable && result.editableReason ? (
                                <Banner variant="warning">Read only — {result.editableReason}</Banner>
                            ) : null}
                            {result?.offsetNote ? <Banner>{result.offsetNote}</Banner> : null}
                            {actionError ? <Banner variant="danger">{actionError}</Banner> : null}

                            <div className="min-h-0 flex-1 overflow-auto">
                                {browse.isLoading ? (
                                    <div className="grid gap-2 p-4">
                                        {Array.from({ length: 8 }, (_, i) => (
                                            <Skeleton key={i} className="h-8 w-full" />
                                        ))}
                                    </div>
                                ) : browse.error ? (
                                    <div className="p-4">
                                        <ErrorAlert
                                            error={browse.error}
                                            fallback="Could not read this table."
                                        />
                                    </div>
                                ) : result ? (
                                    <DataGrid
                                        result={result}
                                        sort={sort}
                                        onSort={toggleSort}
                                        onEdit={(rowIndex, column, value) =>
                                            editCell.mutate({ rowIndex, column, value })
                                        }
                                        onDeleteRow={(rowIndex) => removeRow.mutate(rowIndex)}
                                    />
                                ) : null}
                            </div>

                            <footer className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
                                <span>
                                    Page {page + 1}
                                    {result?.rows.length ? ` · ${result.rows.length} rows shown` : ""}
                                </span>
                                <span className="flex gap-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={cursors.length === 0}
                                        onClick={() => setCursors((c) => c.slice(0, -1))}
                                    >
                                        <ChevronLeft className="size-4" />
                                        Previous
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={!result?.nextCursor}
                                        onClick={() =>
                                            result?.nextCursor &&
                                            setCursors((c) => [...c, result.nextCursor!])
                                        }
                                    >
                                        Next
                                        <ChevronRight className="size-4" />
                                    </Button>
                                </span>
                            </footer>
                        </>
                    )}
                </section>
            </div>

            {selection && result ? (
                <InsertRowDialog
                    open={inserting}
                    projectId={id}
                    selection={selection}
                    columns={result.columns}
                    onClose={() => setInserting(false)}
                />
            ) : null}
        </div>
    );
}
