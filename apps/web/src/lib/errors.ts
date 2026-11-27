import { ApiError } from "./api.js";

/** Message to show for any thrown value: the API's own message when there is one. */
export function errorMessage(error: unknown, fallback: string): string {
    if (error instanceof ApiError) return error.message;
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === "string" && error.trim()) return error;
    return fallback;
}
