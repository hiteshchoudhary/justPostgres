import { useEffect, useState } from "react";
import type { BrowseResult, CellValue } from "@justpostgres/shared";

import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface CellEdit {
  rowIndex: number;
  column: string;
  value: CellValue;
}

/**
 * How a value is displayed.
 *
 * NULL and the empty string are different values and must not look the same —
 * confusing them is a classic way to misread a table. NULL renders as a dimmed
 * marker; an empty string renders as visibly empty quotes.
 */
function CellDisplay({ value }: { value: CellValue }) {
  if (value === null) {
    return <span className="italic text-content-subtle">NULL</span>;
  }
  if (value === "") {
    return <span className="italic text-content-subtle">&quot;&quot;</span>;
  }
  return <span className="whitespace-pre">{value.length > 200 ? `${value.slice(0, 200)}…` : value}</span>;
}

function EditableCell({
  value,
  editable,
  onCommit,
}: {
  value: CellValue;
  editable: boolean;
  onCommit: (next: CellValue) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  useEffect(() => {
    if (!editing) setDraft(value ?? "");
  }, [value, editing]);

  if (!editing) {
    return (
      <div
        onDoubleClick={() => editable && setEditing(true)}
        className={`min-h-[1.5rem] truncate ${editable ? "cursor-text" : ""}`}
        title={editable ? "Double-click to edit" : undefined}
      >
        <CellDisplay value={value} />
      </div>
    );
  }

  const commit = (next: CellValue) => {
    setEditing(false);
    if (next !== value) onCommit(next);
  };

  return (
    <div className="flex items-center gap-1">
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(draft);
          if (e.key === "Escape") {
            setDraft(value ?? "");
            setEditing(false);
          }
        }}
        className="mono h-auto w-full rounded border border-accent bg-surface px-1 py-0.5 text-xs outline-none md:text-xs"
      />
      <button
        // Typing nothing means an empty string; setting NULL has to be explicit.
        onMouseDown={(e) => {
          e.preventDefault();
          commit(null);
        }}
        className="shrink-0 rounded px-1 text-[10px] text-content-subtle hover:text-content"
        title="Set to NULL"
      >
        NULL
      </button>
    </div>
  );
}

export default function DataGrid({
  result,
  onSort,
  sort,
  onEdit,
  onDeleteRow,
}: {
  result: BrowseResult;
  sort?: { column: string; direction: "asc" | "desc" } | undefined;
  onSort?: (column: string) => void;
  onEdit?: (rowIndex: number, column: string, value: CellValue) => void;
  onDeleteRow?: (rowIndex: number) => void;
}) {
  const editable = result.editable && onEdit !== undefined;

  return (
    <Table className="w-full border-collapse text-xs">
      <TableHeader className="sticky top-0 bg-surface-raised">
        <TableRow className="border-b border-border text-left hover:bg-transparent">
          {onDeleteRow ? <TableHead className="h-auto w-8 px-2 py-2" /> : null}
          {result.columns.map((column) => (
            <TableHead
              key={column.name}
              onClick={() => onSort?.(column.name)}
              className={`h-auto px-3 py-2 font-medium whitespace-nowrap ${onSort ? "cursor-pointer hover:text-accent" : ""}`}
            >
              <span className="mono">{column.name}</span>
              {column.isPrimaryKey ? (
                <span className="ml-1 text-[10px] text-accent" title="Primary key">
                  PK
                </span>
              ) : null}
              {sort?.column === column.name ? (
                <span className="ml-1 text-accent">{sort.direction === "asc" ? "↑" : "↓"}</span>
              ) : null}
              <span className="mono ml-2 font-normal text-[10px] text-content-subtle">
                {column.type}
              </span>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {result.rows.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={result.columns.length + (onDeleteRow ? 1 : 0)}
              className="px-3 py-10 text-center text-content-muted"
            >
              No rows.
            </TableCell>
          </TableRow>
        ) : (
          result.rows.map((row, rowIndex) => (
            <TableRow key={rowIndex} className="border-b border-border last:border-0 hover:bg-surface-sunken/40">
              {onDeleteRow ? (
                <TableCell className="w-8 whitespace-normal px-2 py-1.5 align-top">
                  <button
                    onClick={() => onDeleteRow(rowIndex)}
                    disabled={!result.editable}
                    className="text-content-subtle transition-colors hover:text-danger disabled:opacity-30"
                    title={result.editable ? "Delete row" : (result.editableReason ?? "")}
                  >
                    ×
                  </button>
                </TableCell>
              ) : null}
              {result.columns.map((column) => (
                <TableCell key={column.name} className="mono max-w-md whitespace-normal px-3 py-1.5 align-top">
                  <EditableCell
                    value={row[column.name] ?? null}
                    editable={editable}
                    onCommit={(next) => onEdit?.(rowIndex, column.name, next)}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

/** Render rows as CSV, quoting per RFC 4180 and keeping NULL distinct from "". */
export function toCsv(
  columns: string[],
  rows: Array<Record<string, CellValue>>,
): string {
  const escape = (value: CellValue): string => {
    // An unquoted empty field is how CSV spells NULL here; "" is a quoted empty
    // string. Collapsing the two would lose information on round trip.
    if (value === null) return "";
    if (/["\n\r,]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
    return value === "" ? '""' : value;
  };

  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => escape(row[c] ?? null)).join(","));
  }
  return lines.join("\r\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
