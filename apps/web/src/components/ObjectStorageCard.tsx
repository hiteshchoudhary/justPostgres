import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { ObjectStorageInput, StorageProvider } from "@justpostgres/shared";

import { api, ApiError } from "@/lib/api";

import { ToneBadge } from "@/components/ToneBadge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const PROVIDERS: Array<{ id: StorageProvider; label: string; blurb: string }> = [
  { id: "r2", label: "Cloudflare R2", blurb: "No egress fees. The usual choice for a small host." },
  { id: "s3", label: "Amazon S3", blurb: "The original. Egress is charged per gigabyte." },
  {
    id: "s3_compatible",
    label: "S3-compatible",
    blurb: "MinIO, Backblaze B2, DigitalOcean Spaces, Wasabi, Hetzner.",
  },
];

/**
 * How to get the four values this form needs, per provider.
 *
 * Written out rather than linked, because the failure this whole feature is
 * fighting is someone deciding it looks like a half-hour of reading and putting
 * it off — and then losing a host with backups on the same disk.
 */
const INSTRUCTIONS: Record<StorageProvider, string[]> = {
  r2: [
    "In the Cloudflare dashboard, open R2 and create a bucket. The name is what goes in Bucket below.",
    "Still in R2, open API → Manage API tokens → Create API token. Give it Object Read & Write, and scope it to just this bucket.",
    "Copy the Access Key ID and Secret Access Key it shows you once. Cloudflare will not show the secret again.",
    "Your Account ID is in the right-hand sidebar of the R2 page. It is a long hex string, and it is not the bucket name.",
  ],
  s3: [
    "Create a bucket in the region closest to this host. Leave Block Public Access on — nothing here needs the bucket to be public.",
    "Create an IAM user with programmatic access, and attach a policy allowing s3:ListBucket on the bucket plus s3:GetObject, s3:PutObject and s3:DeleteObject on its contents.",
    "Copy the access key id and secret access key from that user.",
    "Set Region to the bucket's own region. It is part of the request signature, so a mismatch fails with a signature error rather than a helpful one.",
  ],
  s3_compatible: [
    "Create a bucket on your provider and an access key scoped to it, with read, write and delete.",
    "Put the endpoint hostname below without the https:// prefix — for example s3.us-west-000.backblazeb2.com or minio.example.com.",
    "The endpoint must speak HTTPS. pgBackRest has no plaintext mode, so a self-hosted endpoint needs a certificate, even a self-signed one with verification turned off.",
    "Most self-hosted gateways need path-style URIs, which is the default here. Switch to host-style only if your provider requires it.",
  ],
};

const EMPTY: ObjectStorageInput = {
  provider: "r2",
  bucket: "",
  prefix: "",
  region: "",
  endpoint: "",
  accountId: "",
  uriStyle: "path",
  verifyTls: true,
  accessKeyId: "",
  secretAccessKey: "",
};

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="block">
      <Label htmlFor={id} className="text-xs font-medium text-content-muted">
        {label}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        aria-describedby={hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.value)}
        className="mono mt-1 h-9 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm transition-colors placeholder:text-content-subtle hover:border-content-subtle focus:border-accent"
      />
      {hint ? <p id={hintId} className="mt-1 text-xs text-content-subtle">{hint}</p> : null}
    </div>
  );
}

/**
 * Object storage for backups.
 *
 * Backups on the same disk as the database survive a dropped table and nothing
 * else — not the host dying, not the disk filling, not the volume being
 * deleted. This is the form that fixes that, and it deliberately includes the
 * provider instructions rather than assuming the operator already knows where
 * Cloudflare hides an account id.
 */
export default function ObjectStorageCard() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ObjectStorageInput>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stored = useQuery({ queryKey: ["object-storage"], queryFn: api.objectStorage });
  const settings = stored.data?.settings ?? null;

  // Load what is stored into the form once, so an edit starts from reality
  // rather than from blank fields the operator has to retype.
  useEffect(() => {
    if (!settings || editing) return;
    setForm({
      provider: settings.provider,
      bucket: settings.bucket,
      prefix: settings.prefix,
      region: settings.region,
      endpoint: settings.endpoint ?? "",
      accountId: settings.accountId ?? "",
      uriStyle: settings.uriStyle,
      verifyTls: settings.verifyTls,
      accessKeyId: settings.accessKeyId,
      // Never round-tripped. Left blank means "keep the stored one".
      secretAccessKey: "",
    });
  }, [settings, editing]);

  const test = useMutation({
    mutationFn: () => api.testObjectStorage(form),
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const save = useMutation({
    mutationFn: () => api.saveObjectStorage(form),
    onSuccess: () => {
      setError(null);
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ["object-storage"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const clear = useMutation({
    mutationFn: api.clearObjectStorage,
    onSuccess: () => {
      setForm(EMPTY);
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ["object-storage"] });
    },
  });

  const set = <K extends keyof ObjectStorageInput>(key: K, value: ObjectStorageInput[K]) => {
    setEditing(true);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const result = test.data ?? settings?.lastTest ?? null;
  const configured = Boolean(settings);

  return (
    <Card className="mb-6 gap-0 py-0">
      <CardHeader className="border-b border-border px-5 py-4">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          Backups in object storage
          {configured ? (
            <ToneBadge tone="ok" dot>
              configured
            </ToneBadge>
          ) : (
            <ToneBadge tone="warn" dot>
              local disk
            </ToneBadge>
          )}
        </CardTitle>
        <CardDescription className="mt-1 max-w-2xl text-xs leading-relaxed">
          Backups on the same disk as the database survive a dropped table and nothing else. Not the host
          dying, not the disk filling, not someone removing the wrong volume. Point them at a bucket and
          they survive all three.
        </CardDescription>
        {configured ? (
          <CardAction>
            <Button variant="secondary" size="sm" onClick={() => clear.mutate()} disabled={clear.isPending}>
              {clear.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Stop using it
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>

      <div className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap gap-2">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => set("provider", p.id)}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                form.provider === p.id
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border hover:bg-surface-raised"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-content-subtle">
          {PROVIDERS.find((p) => p.id === form.provider)?.blurb}
        </p>
      </div>

      <div className="border-b border-border px-4 py-3">
        <div className="text-xs font-medium text-content-muted">Where to find these</div>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-content-muted">
          {INSTRUCTIONS[form.provider].map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </div>

      <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
        <Field
          label="Bucket"
          value={form.bucket}
          onChange={(v) => set("bucket", v)}
          placeholder="justpostgres-backups"
        />

        {form.provider === "r2" ? (
          <Field
            label="Cloudflare account ID"
            hint="From the R2 sidebar. Not the bucket name."
            value={form.accountId ?? ""}
            onChange={(v) => set("accountId", v)}
            placeholder="a1b2c3d4e5f6..."
          />
        ) : null}

        {form.provider === "s3" ? (
          <Field
            label="Region"
            hint="The bucket's own region. It is part of the request signature."
            value={form.region ?? ""}
            onChange={(v) => set("region", v)}
            placeholder="eu-west-1"
          />
        ) : null}

        {form.provider === "s3_compatible" ? (
          <>
            <Field
              label="Endpoint"
              hint="Hostname only, no https://. A port may be included."
              value={form.endpoint ?? ""}
              onChange={(v) => set("endpoint", v)}
              placeholder="s3.us-west-000.backblazeb2.com"
            />
            <Field
              label="Region"
              hint="Whatever your provider expects. Often us-east-1 for gateways that ignore it."
              value={form.region ?? ""}
              onChange={(v) => set("region", v)}
              placeholder="us-east-1"
            />
          </>
        ) : null}

        <Field
          label="Access key ID"
          value={form.accessKeyId}
          onChange={(v) => set("accessKeyId", v)}
        />
        <Field
          label="Secret access key"
          type="password"
          hint={
            settings?.secretAccessKeySet
              ? "Stored and encrypted. Leave blank to keep the current one."
              : "Stored encrypted with JP_MASTER_KEY. Never shown again."
          }
          value={form.secretAccessKey ?? ""}
          onChange={(v) => set("secretAccessKey", v)}
        />
        <Field
          label="Prefix"
          hint="Optional. A folder inside the bucket, so one bucket can hold several hosts."
          value={form.prefix ?? ""}
          onChange={(v) => set("prefix", v)}
          placeholder="host-1"
        />

        {form.provider === "s3_compatible" ? (
          <div className="flex items-end gap-4">
            <label className="flex items-center gap-2 text-xs text-content-muted">
              <input
                type="checkbox"
                checked={form.uriStyle === "path"}
                onChange={(e) => set("uriStyle", e.target.checked ? "path" : "host")}
              />
              Path-style URIs
            </label>
            <label className="flex items-center gap-2 text-xs text-content-muted">
              <input
                type="checkbox"
                checked={form.verifyTls !== false}
                onChange={(e) => set("verifyTls", e.target.checked)}
              />
              Verify the TLS certificate
            </label>
          </div>
        ) : null}
      </div>

      {error ? <p className="px-4 pb-2 text-xs text-danger">{error}</p> : null}

      {result ? (
        <p className={`px-4 pb-3 text-xs ${result.ok ? "text-ok" : "text-danger"}`}>{result.detail}</p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
        <p className="text-xs text-content-subtle">
          Testing lists the bucket, which proves the endpoint, region and credentials. Write access is
          proven by the first backup.
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => test.mutate()} disabled={test.isPending}>
            {test.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {test.isPending ? "Testing…" : "Test connection"}
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {save.isPending ? "Saving…" : configured ? "Update" : "Save"}
          </Button>
        </div>
      </div>

      {configured ? (
        <p className="border-t border-border px-4 py-3 text-xs text-content-subtle">
          New projects back up here from now on. Existing projects keep their current repository until
          you move them — each project's <strong>Backups</strong> tab has the button, and moving one
          restarts its database and takes a fresh full backup.
        </p>
      ) : null}
    </Card>
  );
}
