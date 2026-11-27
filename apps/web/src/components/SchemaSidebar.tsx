import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RelationInfo } from "@justpostgres/shared";

import { api } from "@/lib/api";
import { formatBytes } from "@/lib/format";

const KIND_LABEL: Record<RelationInfo["kind"], string> = {
  table: "table",
  partitioned: "partitioned",
  view: "view",
  materialized: "matview",
  foreign: "foreign",
};

function estimateLabel(relation: RelationInfo): string {
  // "never analysed" and "estimated zero rows" are different facts, and only one
  // of them is worth showing as a number.
  const rows =
    relation.estimatedRows === null
      ? "—"
      : relation.estimatedRows >= 1_000_000
        ? `${(relation.estimatedRows / 1_000_000).toFixed(1)}M`
        : relation.estimatedRows >= 1000
          ? `${Math.round(relation.estimatedRows / 1000)}k`
          : String(relation.estimatedRows);
  return `~${rows} rows · ${formatBytes(relation.sizeBytes)}`;
}

export default function SchemaSidebar({
  projectId,
  selected,
  onSelect,
}: {
  projectId: string;
  selected: { schema: string; table: string } | null;
  onSelect: (relation: { schema: string; table: string }) => void;
}) {
  const [search, setSearch] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["schema", projectId],
    queryFn: () => api.schema(projectId),
    staleTime: 30_000,
  });

  const schemas = useMemo(() => {
    const all = data?.schemas ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return all;
    return all
      .map((s) => ({
        ...s,
        relations: s.relations.filter((r) => r.name.toLowerCase().includes(needle)),
      }))
      .filter((s) => s.relations.length > 0);
  }, [data, search]);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border">
      <div className="border-b border-border p-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter tables…"
          className="w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-accent"
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {isLoading ? (
          <p className="px-2 py-4 text-xs text-content-muted">Loading schema…</p>
        ) : error ? (
          <p className="px-2 py-4 text-xs text-danger">Could not read the schema.</p>
        ) : schemas.length === 0 ? (
          <p className="px-2 py-4 text-xs text-content-muted">
            {search ? "Nothing matches." : "No tables yet."}
          </p>
        ) : (
          schemas.map((schema) => (
            <div key={schema.name} className="mb-3">
              <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-content-subtle">
                {schema.name}
              </div>
              {schema.relations.map((relation) => {
                const isSelected =
                  selected?.schema === relation.schema && selected?.table === relation.name;
                return (
                  <button
                    key={`${relation.schema}.${relation.name}`}
                    onClick={() => onSelect({ schema: relation.schema, table: relation.name })}
                    title={relation.comment ?? undefined}
                    className={`block w-full rounded-md px-2 py-1.5 text-left transition-colors ${
                      isSelected ? "bg-surface-sunken" : "hover:bg-surface-sunken/60"
                    }`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span
                        className={`mono truncate text-xs ${isSelected ? "text-content" : "text-content-muted"}`}
                      >
                        {relation.name}
                      </span>
                      {relation.kind !== "table" ? (
                        <span className="shrink-0 text-[10px] text-content-subtle">
                          {KIND_LABEL[relation.kind]}
                        </span>
                      ) : null}
                    </span>
                    <span className="block text-[10px] text-content-subtle">
                      {estimateLabel(relation)}
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
