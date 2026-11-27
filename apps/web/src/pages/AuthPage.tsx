import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Loader2, LogIn, UserPlus } from "lucide-react";

import { api, ApiError } from "@/lib/api";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/Logo";

const MIN_PASSWORD_LENGTH = 12;

/** A label, a control and optional helper text, wired together by id. */
function FormField({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * First-run setup and sign-in, in one component because they are the same form
 * with a different verb. Which one renders is decided by the server's auth
 * status, never by the client.
 */
export default function AuthPage({ setupRequired }: { setupRequired: boolean }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: () =>
      setupRequired
        ? api.setup(email, password, setupToken)
        : api.login(email, password),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth"] }),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setLocalError(null);

    if (setupRequired) {
      if (!setupToken.trim()) {
        setLocalError(
          "The setup token is required. It was printed to the control plane's log.",
        );
        return;
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        setLocalError(
          `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        );
        return;
      }
      if (password !== confirm) {
        setLocalError("Passwords do not match.");
        return;
      }
    }
    submit.mutate();
  };

  const serverError =
    submit.error instanceof ApiError
      ? submit.error.message
      : submit.error
        ? "Something went wrong."
        : null;
  const error = localError ?? serverError;

  return (
    <div className="relative flex min-h-svh items-center justify-center px-6 py-12">
      {/* A soft wash of the brand colour behind the card. The sign-in page was
          a form floating in a flat void, which reads as unfinished rather than
          minimal. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-105 bg-linear-to-b from-primary/10 to-transparent"
      />

      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo size={64} />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">
            just<span className="text-primary">postgres</span>
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {setupRequired
              ? "Create the administrator account for this instance."
              : "Sign in to continue."}
          </p>
        </div>

        <Card className="py-0 shadow-sm">
          <form onSubmit={onSubmit} className="space-y-4 p-6">
            {setupRequired && (
              <FormField
                id="setup-token"
                label="Setup token"
                hint={
                  <>
                    Printed to the control plane's log when it started. It proves
                    you are the operator rather than the first stranger to find
                    this page. On the server, run:
                    <code className="mt-1.5 block rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] break-all text-foreground">
                      docker logs $(docker ps -qf name=control-plane) 2&gt;&amp;1
                      | grep jp_setup
                    </code>
                  </>
                }
              >
                <Input
                  id="setup-token"
                  required
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  placeholder="jp_setup_…"
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value)}
                  aria-describedby="setup-token-hint"
                />
              </FormField>
            )}

            <FormField id="email" label="Email">
              <Input
                id="email"
                type="email"
                required
                autoFocus={!setupRequired}
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </FormField>

            <FormField id="password" label="Password">
              <Input
                id="password"
                type="password"
                required
                autoComplete={setupRequired ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </FormField>

            {setupRequired && (
              <FormField
                id="confirm"
                label="Confirm password"
                hint={`At least ${MIN_PASSWORD_LENGTH} characters. There is no password reset — this account is the only way in.`}
              >
                <Input
                  id="confirm"
                  type="password"
                  required
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  aria-describedby="confirm-hint"
                />
              </FormField>
            )}

            {error && (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={submit.isPending}
            >
              {submit.isPending ? (
                <Loader2 className="animate-spin" />
              ) : setupRequired ? (
                <UserPlus />
              ) : (
                <LogIn />
              )}
              {submit.isPending
                ? "Working…"
                : setupRequired
                  ? "Create account"
                  : "Sign in"}
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-xs leading-relaxed text-muted-foreground">
          {setupRequired
            ? "This instance has no administrator yet."
            : "Self-hosted. Your databases never leave this machine."}
        </p>
      </div>
    </div>
  );
}
