import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import {
    FILTER_OPERATOR_LABELS,
    FILTER_OPERATORS,
    VALUELESS_OPERATORS,
    type Filter,
    type FilterOperator,
} from "@justpostgres/shared";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

interface FilterBarProps {
    columns: string[];
    filters: Filter[];
    onChange: (filters: Filter[]) => void;
}

export function FilterBar({ columns, filters, onChange }: FilterBarProps) {
    const [column, setColumn] = useState(columns[0] ?? "");
    const [operator, setOperator] = useState<FilterOperator>("eq");
    const [value, setValue] = useState("");

    useEffect(() => {
        if (!columns.includes(column)) setColumn(columns[0] ?? "");
    }, [columns, column]);

    const needsValue = !VALUELESS_OPERATORS.includes(operator);

    const add = () => {
        if (!column) return;
        if (needsValue && value === "") return;
        onChange([...filters, { column, operator, ...(needsValue ? { value } : {}) }]);
        setValue("");
    };

    return (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
            {filters.map((filter, index) => (
                <Badge
                    key={`${filter.column}-${index}`}
                    variant="secondary"
                    className="gap-1.5 py-1 pr-1 font-mono text-xs"
                >
                    {filter.column} {FILTER_OPERATOR_LABELS[filter.operator]} {filter.value ?? ""}
                    <button
                        type="button"
                        aria-label={`Remove filter on ${filter.column}`}
                        onClick={() => onChange(filters.filter((_, i) => i !== index))}
                        className="rounded-sm p-0.5 text-muted-foreground hover:bg-background hover:text-destructive"
                    >
                        <X className="size-3" />
                    </button>
                </Badge>
            ))}

            <Select value={column} onValueChange={(v) => v != null && setColumn(String(v))}>
                <SelectTrigger className="h-8 w-40 text-xs" aria-label="Column">
                    <SelectValue>{column}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                    {columns.map((c) => (
                        <SelectItem key={c} value={c}>
                            {c}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            <Select
                value={operator}
                onValueChange={(v) => v != null && setOperator(String(v) as FilterOperator)}
            >
                <SelectTrigger className="h-8 w-36 text-xs" aria-label="Operator">
                    <SelectValue>{FILTER_OPERATOR_LABELS[operator]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                    {FILTER_OPERATORS.map((op) => (
                        <SelectItem key={op} value={op}>
                            {FILTER_OPERATOR_LABELS[op]}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {needsValue ? (
                <Input
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && add()}
                    placeholder="Value"
                    aria-label="Filter value"
                    className="h-8 w-40 text-xs"
                />
            ) : null}

            <Button type="button" variant="outline" size="sm" onClick={add}>
                <Plus className="size-4" />
                Add filter
            </Button>
        </div>
    );
}
