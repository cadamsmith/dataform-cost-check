import { existsSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linkDependencies } from "../src/base-checkout.ts";

function project(withPackageJson: boolean, withModules: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "dcc-link-"));
  if (withPackageJson) writeFileSync(join(dir, "package.json"), "{}");
  if (withModules) mkdirSync(join(dir, "node_modules"));
  return dir;
}

describe("linkDependencies", () => {
  it("links head's node_modules into a base checkout that has a package.json", async () => {
    const head = project(true, true);
    const base = project(true, false);
    await linkDependencies(head, base);
    expect(readlinkSync(join(base, "node_modules"))).toBe(join(head, "node_modules"));
  });

  it("leaves projects without a package.json alone", async () => {
    const head = project(false, true);
    const base = project(false, false);
    await linkDependencies(head, base);
    expect(existsSync(join(base, "node_modules"))).toBe(false);
  });

  it("does nothing when head has nothing installed", async () => {
    const base = project(true, false);
    await linkDependencies(project(true, false), base);
    expect(existsSync(join(base, "node_modules"))).toBe(false);
  });
});
