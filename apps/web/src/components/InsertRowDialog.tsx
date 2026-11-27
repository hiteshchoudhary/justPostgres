import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { CellValue } from "@justpostgres/shared";
import { api } from "../lib/api.js";
import { ErrorAlert } from "./ErrorAlert";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface InsertRowDialogProps {
    open: boolean;
    projectId: string;
    selection: { schema: string; table: string };
    columns: Array<{ name: string; type: string; nullable: boolean }>;
    onClose: () => void;
}

export function InsertRowDialog({
    open,
    projectId,
    selection,
    columns,
    onClose,
}: InsertRowDialogProps) {
    const queryClient = useQueryClient();
    const [values, setValues] = useState<Record<string, string>>({});
    const [nulls, setNulls] = useState<Record<string, boolean>>({});

    const close = () => {
        setValues({});
        setNulls({});
        insert.reset();
        onClose();
    };

    const insert = useMutation({
        mutationFn: () => {
            const payload: Record<string, CellValue> = {};
            for (const column of columns) {
                if (nulls[column.name]) payload[column.name] = null;
                else if (values[column.name] !== undefined) payload[column.name] = values[column.name]!;
            }
            return api.insertRow(projectId, selection.schema, selection.table, payload);
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["browse"] });
            close();
        },
    });

    return (
        <Dialog open={open} onOpenChange={(next) => !next && close()}>
            <DialogContent>
                <form
                    className="grid gap-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        insert.mutate();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>Insert into {selection.table}</DialogTitle>
                        <DialogDescription>Columns left empty take their default.</DialogDescription>
                    </DialogHeader>

                    <div className="grid max-h-96 gap-4 overflow-y-auto pr-1">
                        {columns.map((column) => {
                            const isNull = nulls[column.name] ?? false;
                            return (
                                <div key={column.name} className="grid gap-1.5">
                                    <div className="flex items-baseline justify-between gap-2">
                                        <Label htmlFor={`col-${column.name}`} className="font-mono text-xs">
                                            {column.name}
                                        </Label>
                                        <span className="font-mono text-[10px] text-muted-foreground">
                                            {column.type}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <Input
                                            id={`col-${column.name}`}
                                            disabled={isNull}
                                            value={values[column.name] ?? ""}
                                            onChange={(e) =>
                                                setValues({ ...values, [column.name]: e.target.value })
                                            }
                                            className="font-mono text-xs"
                                        />
                                        {column.nullable ? (
                                            <div className="flex shrink-0 items-center gap-1.5">
                                                <Checkbox
                                                    id={`null-${column.name}`}
                                                    checked={isNull}
                                                    onCheckedChange={(checked) =>
                                                        setNulls({ ...nulls, [column.name]: checked === true })
                                                    }
                                                />
                                                <Label
                                                    htmlFor={`null-${column.name}`}
                                                    className="text-xs text-muted-foreground"
                                                >
                                                    NULL
                                                </Label>
                                            </div>
                                        ) : null}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {insert.error ? <ErrorAlert error={insert.error} fallback="Insert failed." /> : null}

                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={close}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={insert.isPending}>
                            {insert.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                            {insert.isPending ? "Inserting…" : "Insert row"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
