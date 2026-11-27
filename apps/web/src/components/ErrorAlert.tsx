import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { errorMessage } from "../lib/errors";

interface ErrorAlertProps {
    error: unknown;
    fallback: string;
    title?: string;
    className?: string;
}

export function ErrorAlert({ error, fallback, title, className }: ErrorAlertProps) {
    return (
        <Alert variant="destructive" role="alert" className={className}>
            {title ? <AlertTitle>{title}</AlertTitle> : null}
            <AlertDescription>{errorMessage(error, fallback)}</AlertDescription>
        </Alert>
    );
}
