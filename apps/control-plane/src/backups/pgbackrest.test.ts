import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { StanzaInfo } from "@justpostgres/shared";
import {
  archivingPostgresArgs,
  backupEnv,
  backupForLsn,
  needsSourceVolume,
  parseLsn,
  SOURCE_REPO_MOUNT,
  SOURCE_S3_KEY_ENV,
  SOURCE_S3_SECRET_ENV,
  sourceRepoForRestore,
  sourceRepoSecretEnv,
  sourceRestoreCommand,
  type RepoSpec,
} from "./pgbackrest.js";
import { recoveryTargetArgs } from "../jobs/handlers/restore-run.js";

/**
 * Restore once read every source repository as a local volume, so a project on
 * object storage restored from an empty or stale volume — and verification,
 * hardcoded the same way, said it was fine. These pin the repository a restore
 * reads to the one the project actually archives to.
 */

const s3Source: RepoSpec = {
  type: "s3",
  path: "/srcref",
  s3: {
    bucket: "jp-backups",
    endpoint: "minio.example.test",
    port: 9000,
    region: "auto",
    key: "AKIASOURCEKEY",
    secret: "s3cr3t/with+chars",
    uriStyle: "path",
    verifyTls: false,
  },
};

const s3Own: RepoSpec = {
  type: "s3",
  path: "/ownref",
  s3: {
    bucket: "other-bucket",
    endpoint: "r2.example.test",
    port: 8443,
    region: "us-east-1",
    key: "AKIAOWNKEY",
    secret: "own-secret",
    uriStyle: "host",
    verifyTls: true,
  },
};

test("a local source is read from the read-only mount; an S3 source from its bucket", () => {
  assert.deepEqual(sourceRepoForRestore({ type: "posix", path: "/var/lib/pgbackrest" }), {
    type: "posix",
    path: SOURCE_REPO_MOUNT,
  });
  assert.deepEqual(sourceRepoForRestore(s3Source), s3Source);
  assert.equal(needsSourceVolume({ type: "posix", path: SOURCE_REPO_MOUNT }), true);
  assert.equal(needsSourceVolume(s3Source), false);
});

test("an S3 restore_command targets the source bucket and never contains the secret", () => {
  const cmd = sourceRestoreCommand({ stanza: "jp-srcref", spec: s3Source });

  for (const expected of [
    "--repo1-type=s3",
    "--repo1-path=/srcref",
    "--repo1-s3-bucket=jp-backups",
    "--repo1-s3-endpoint=minio.example.test",
    "--repo1-storage-port=9000",
    "--repo1-storage-verify-tls=n",
    "--repo1-s3-uri-style=path",
    "--stanza=jp-srcref",
    "archive-get %f \"%p\"",
  ]) {
    assert.ok(cmd.includes(expected), `missing ${expected} in: ${cmd}`);
  }

  // postgresql.auto.conf lives in the data directory and in every backup of it.
  assert.ok(!cmd.includes("AKIASOURCEKEY"), "access key must not be written into the command");
  assert.ok(!cmd.includes("s3cr3t"), "secret must not be written into the command");
  assert.deepEqual(sourceRepoSecretEnv(s3Source), {
    [SOURCE_S3_KEY_ENV]: "AKIASOURCEKEY",
    [SOURCE_S3_SECRET_ENV]: "s3cr3t/with+chars",
  });
  assert.deepEqual(sourceRepoSecretEnv({ type: "posix", path: SOURCE_REPO_MOUNT }), {});
});

test("restore_command clears every repo1 variable the container's own repository sets", () => {
  // The restored project's own repo1 is in the container environment, and
  // pgBackRest merges environment with command line.
  const ownEnv = backupEnv({ stanza: "jp-ownref", repo: s3Own, retentionFull: 2 });
  const repo1Vars = Object.keys(ownEnv).filter((k) => k.startsWith("PGBACKREST_REPO1_"));
  assert.ok(repo1Vars.length >= 8, "fixture should exercise every S3 option");

  for (const spec of [sourceRepoForRestore({ type: "posix", path: "/x" }), s3Source]) {
    const cmd = sourceRestoreCommand({ stanza: "jp-srcref", spec });
    for (const name of repo1Vars) {
      assert.ok(cmd.includes(`-u ${name}`), `${spec.type} restore_command does not clear ${name}`);
    }
  }
});

test("restore_command, run through a shell, hands pgBackRest only the source repository", () => {
  // Swap pgbackrest for a stub that prints what it received, then run the
  // command the way Postgres does: through /bin/sh, with the restored
  // project's own repository in the environment.
  const dir = mkdtempSync(join(tmpdir(), "jp-restore-cmd-"));
  const stub = join(dir, "pgbackrest");
  writeFileSync(
    stub,
    '#!/bin/sh\nenv | grep "^PGBACKREST_REPO1_" | sort\nfor a in "$@"; do echo "ARG $a"; done\n',
  );
  chmodSync(stub, 0o755);

  const ownEnv = backupEnv({ stanza: "jp-ownref", repo: s3Own, retentionFull: 2 });
  const cmd = sourceRestoreCommand({ stanza: "jp-srcref", spec: s3Source })
    .replace("%f", "000000010000000000000001")
    .replace("%p", "/tmp/out");

  const output = execFileSync("/bin/sh", ["-c", cmd], {
    encoding: "utf8",
    env: {
      PATH: `${dir}:/usr/bin:/bin`,
      ...ownEnv,
      ...sourceRepoSecretEnv(s3Source),
    },
  });

  const envLines = output.split("\n").filter((l) => l.startsWith("PGBACKREST_REPO1_"));
  assert.deepEqual(envLines, [
    "PGBACKREST_REPO1_S3_KEY=AKIASOURCEKEY",
    "PGBACKREST_REPO1_S3_KEY_SECRET=s3cr3t/with+chars",
  ]);
  assert.ok(!output.includes("other-bucket"), "the restored project's bucket leaked into archive-get");
  assert.ok(output.includes("ARG --repo1-s3-bucket=jp-backups"));
  assert.ok(output.includes("ARG /tmp/out"));
});

test("a value that could break out of the shell is refused, not escaped", () => {
  const evil: RepoSpec = { ...s3Source, s3: { ...s3Source.s3!, bucket: "b'; rm -rf / #" } };
  assert.throws(() => sourceRestoreCommand({ stanza: "jp-srcref", spec: evil }), /cannot carry/);
});

test("archive_timeout comes from configuration", () => {
  const args = archivingPostgresArgs("jp-x", 15);
  assert.ok(args.includes("archive_timeout=15"));
  assert.ok(args.includes("archive_command=pgbackrest --stanza=jp-x archive-push %p"));
});

// --- log-position targets ----------------------------------------------------

function stanza(backups: Array<{ label: string; lsnStop: string | null; dbId?: number }>, currentDbId = 1): StanzaInfo {
  return {
    name: "jp-x",
    status: { code: 0, message: "ok" },
    history: [{ id: currentDbId, version: "17" }],
    currentDbId,
    archive: [],
    backups: backups.map((b, i) => ({
      label: b.label,
      type: "full",
      dbId: b.dbId ?? currentDbId,
      startedAt: i * 1000,
      finishedAt: i * 1000 + 500,
      repoSizeBytes: 0,
      databaseSizeBytes: 0,
      walStart: null,
      walStop: null,
      lsnStart: null,
      lsnStop: b.lsnStop,
    })),
  };
}

test("LSNs compare numerically, not as text", () => {
  assert.ok(parseLsn("0/FFFFFFFF") < parseLsn("1/0"));
  assert.ok(parseLsn("A/0") > parseLsn("9/FFFFFFFF"));
  assert.equal(parseLsn("16/B374D848"), (0x16n << 32n) | 0xb374d848n);
  assert.throws(() => parseLsn("16-B374D848"));
});

test("an LSN restore starts from the newest backup that had finished by then", () => {
  const info = stanza([
    { label: "F1", lsnStop: "0/3000100" },
    { label: "F2", lsnStop: "0/9000100" },
    { label: "F3", lsnStop: "1/2000100" },
  ]);
  assert.deepEqual(backupForLsn(info, "0/A000000"), { ok: true, label: "F2" });
  assert.deepEqual(backupForLsn(info, "1/2000100"), { ok: true, label: "F3" });
  assert.deepEqual(backupForLsn(info, "0/1000000"), {
    ok: false,
    reason: "before_window",
    earliest: "0/3000100",
  });
});

test("an LSN restore ignores backups stranded by a major-version upgrade", () => {
  const info = stanza(
    [
      { label: "OLD", lsnStop: "0/1000000", dbId: 1 },
      { label: "NEW", lsnStop: "0/5000000", dbId: 2 },
    ],
    2,
  );
  assert.deepEqual(backupForLsn(info, "0/2000000"), { ok: false, reason: "before_window", earliest: "0/5000000" });
  assert.deepEqual(backupForLsn(stanza([]), "0/1"), { ok: false, reason: "no_backups" });
  assert.deepEqual(backupForLsn(stanza([{ label: "F", lsnStop: null }]), "0/1"), {
    ok: false,
    reason: "no_lsn_info",
  });
});

test("recovery target options", () => {
  assert.deepEqual(recoveryTargetArgs(undefined), ["--type=default"]);
  assert.deepEqual(recoveryTargetArgs({ kind: "time", at: Date.UTC(2026, 10, 7, 14, 32, 5, 900) }), [
    "--type=time",
    "--target=2026-11-07 14:32:05+00",
    "--target-action=promote",
  ]);
  assert.deepEqual(recoveryTargetArgs({ kind: "lsn", lsn: "0/A000000", backupSet: "F2" }), [
    "--type=lsn",
    "--target=0/A000000",
    "--target-action=promote",
    "--set=F2",
  ]);
});
