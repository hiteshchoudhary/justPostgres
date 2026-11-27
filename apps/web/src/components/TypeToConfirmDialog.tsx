import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "./ui/button";
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

interface TypeToConfirmDialogProps {
    open: boolean;
    title: string;
    description: ReactNode;
    /** The exact text the person has to type before the action unlocks. */
    confirmText: string;
    confirmLabel: string;
    pendingLabel?: string;
    pending?: boolean;
    onClose: () => void;
    onConfirm: () => void;
}

/** For destructive actions that cannot be undone: delete a project, drop a branch. */
export function TypeToConfirmDialog({
    open,
    title,
    description,
    confirmText,
    confirmLabel,
    pendingLabel,
    pending = false,
    onClose,
    onConfirm,
}: TypeToConfirmDialogProps) {
    const [typed, setTyped] = useState("");
    const matches = typed === confirmText;

    const close = () => {
        setTyped("");
        onClose();
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !next && close()}>
            <DialogContent>
                <form
                    className="grid gap-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (matches && !pending) onConfirm();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{title}</DialogTitle>
                        <DialogDescription>{description}</DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-2">
                        <Label htmlFor="confirm-text">
                            Type <span className="font-mono text-foreground">{confirmText}</span> to
                            confirm
                        </Label>
                        <Input
                            id="confirm-text"
                            autoFocus
                            autoComplete="off"
                            value={typed}
                            onChange={(e) => setTyped(e.target.value)}
                        />
                    </div>

                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={close}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="destructive" disabled={!matches || pending}>
                            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                            {pending ? (pendingLabel ?? confirmLabel) : confirmLabel}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
