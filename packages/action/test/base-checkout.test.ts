import { existsSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyDependencies } from "../src/base-checkout.ts";

function project(withPackageJson: boolean, withModules: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "dcc-link-"));
  if (withPackageJson) writeFileSync(join(dir, "package.json"), "{}");
  if (withModules) mkdirSync(join(dir, "node_modules"));
  return dir;
}

describe("copyDependencies", () => {
  it("copies head's node_modules into a base checkout that has a package.json", async () => {
    const head = project(true, true);
    writeFileSync(join(head, "node_modules", "marker.js"), "module.exports = 1;");
    const base = project(true, false);
    await copyDependencies(head, base);
    expect(lstatSync(join(base, "node_modules")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(base, "node_modules", "marker.js"))).toBe(true);
  });

  it("leaves projects without a package.json alone", async () => {
    const head = project(false, true);
    const base = project(false, false);
    await copyDependencies(head, base);
    expect(existsSync(join(base, "node_modules"))).toBe(false);
  });

  it("does nothing when head has nothing installed", async () => {
    const base = project(true, false);
    await copyDependencies(project(true, false), base);
    expect(existsSync(join(base, "node_modules"))).toBe(false);
  });
});
