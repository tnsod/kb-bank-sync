import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  }));
  return nested.flat();
}

describe("cross-platform application boundaries", () => {
  it("keeps host- and deployment-specific absolute paths out of core TypeScript", async () => {
    const files = await sourceFiles(path.resolve("src"));
    const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
    const source = contents.join("\n");
    expect(source).not.toContain("C:\\kb-bank-sync");
    expect(source).not.toContain("C:\\secure");
    expect(source).not.toMatch(/\/Users\/[^/\s]+/u);
    expect(source).not.toContain("/opt/kb-bank-sync");
    expect(source).not.toContain("/run/secrets");
  });

  it("provides a non-executing Windows validation mode and a guarded daily task definition", async () => {
    const runner = await readFile("deploy/windows/run-sync.ps1", "utf8");
    const register = await readFile("deploy/windows/register-task.ps1", "utf8");
    const unregister = await readFile("deploy/windows/unregister-task.ps1", "utf8");
    expect(runner).toContain("[switch]$ValidateOnly");
    expect(runner).toContain('"Local\\KbBankSync"');
    expect(runner).toContain("compose run --rm kb-sync");
    expect(runner).toContain('Join-Path $PSScriptRoot "..\\.."');
    expect(register).toContain('New-ScheduledTaskTrigger -Daily -At "04:10"');
    expect(register).toContain("-StartWhenAvailable -MultipleInstances IgnoreNew");
    expect(register).toContain("-LogonType Interactive");
    expect(register).not.toContain("Start-ScheduledTask");
    expect(unregister).toContain('Unregister-ScheduledTask -TaskName $taskName');
  });

  it("uses a mkdir lock and launchd on macOS without Linux-only flock", async () => {
    const runner = await readFile("deploy/macos/run-sync.sh", "utf8");
    const installer = await readFile("deploy/macos/install-launch-agent.sh", "utf8");
    const uninstaller = await readFile("deploy/macos/uninstall-launch-agent.sh", "utf8");
    const template = await readFile("deploy/macos/com.kb-bank-sync.daily.plist.template", "utf8");
    expect(runner).toContain('LOCK_DIR="${PROJECT_DIR}/.sync-lock"');
    expect(runner).toContain('mkdir "$LOCK_DIR"');
    expect(runner).toContain("docker compose run --rm kb-sync");
    expect(runner).not.toContain("flock");
    expect(installer).toContain("plutil -lint");
    expect(installer).toContain('launchctl bootstrap "$DOMAIN" "$TARGET"');
    expect(installer).not.toContain("launchctl kickstart");
    expect(uninstaller).toContain('launchctl bootout "$SERVICE"');
    expect(template).toContain("<string>com.kb-bank-sync.daily</string>");
    expect(template).toContain("<integer>4</integer>");
    expect(template).toContain("<integer>10</integer>");
  });

  it("documents Cloud Run as a single-task container job without Compose or system schedulers", async () => {
    const documentation = await readFile("docs/cloud-run-deployment.md", "utf8");
    expect(documentation).toContain("--tasks=1");
    expect(documentation).toContain("--max-retries=0");
    expect(documentation).toContain("--task-timeout=15m");
    expect(documentation).toContain("/run/secrets/google-service-account.json");
    expect(documentation).toContain('--schedule="10 4 * * *"');
    expect(documentation).toContain('--time-zone="Asia/Seoul"');
  });
});
