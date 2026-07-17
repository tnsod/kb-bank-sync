import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateServiceAccountKeyFile } from "../src/spreadsheet/google-auth.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kb-bank-sync-auth-"));
  directories.push(directory);
  return directory;
}

async function credentialFile(directory: string, value: unknown, name = "credential.json"): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(file, JSON.stringify(value), "utf8");
  return file;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Google service account key validation", () => {
  const valid = { type: "service_account", project_id: "test", client_email: "service@example.test", private_key: "private", token_uri: "https://oauth2.googleapis.com/token" };

  it("resolves relative paths from the project root", async () => {
    const directory = await temporaryDirectory();
    await credentialFile(directory, valid);
    const result = await validateServiceAccountKeyFile("credential.json", directory);
    expect(result.resolvedPath).toBe(path.join(directory, "credential.json"));
    expect(result.credential.type).toBe("service_account");
  });

  it("accepts an absolute quoted path without exposing credential fields", async () => {
    const directory = await temporaryDirectory();
    const file = await credentialFile(directory, valid);
    const result = await validateServiceAccountKeyFile(` "${file}" `, directory);
    expect(result.resolvedPath).toBe(file);
    expect(result.credential.client_email).toBeDefined();
  });

  it("rejects invalid credential types and missing fields", async () => {
    const directory = await temporaryDirectory();
    const user = await credentialFile(directory, { type: "authorized_user", client_id: "x" }, "user.json");
    await expect(validateServiceAccountKeyFile(user)).rejects.toMatchObject({ code: "GOOGLE_CREDENTIAL_TYPE_INVALID" });
    const missing = await credentialFile(directory, { type: "service_account", client_email: "x" }, "missing.json");
    await expect(validateServiceAccountKeyFile(missing)).rejects.toMatchObject({ code: "GOOGLE_CREDENTIAL_FIELDS_MISSING" });
  });

  it("distinguishes missing and invalid JSON files", async () => {
    const directory = await temporaryDirectory();
    await expect(validateServiceAccountKeyFile(path.join(directory, "absent.json"))).rejects.toMatchObject({ code: "GOOGLE_KEY_FILE_NOT_FOUND" });
    const invalid = path.join(directory, "invalid.json");
    await writeFile(invalid, "{invalid", "utf8");
    await expect(validateServiceAccountKeyFile(invalid)).rejects.toMatchObject({ code: "GOOGLE_KEY_JSON_INVALID" });
  });
});
