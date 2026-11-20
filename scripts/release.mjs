#!/usr/bin/env node
/* global process, console */ // Bump every place the version lives, then check and build. Usage: pnpm release 0.4.0
// It edits files only: review the diff, open a PR, and tag vX.Y.Z on main after it merges.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage: pnpm release <major.minor.patch>, e.g. pnpm release 0.4.0");
  process.exit(2);
}

/** Replace `pattern` in `file`, failing loudly if it is not there. */
function bump(file, pattern, replacement) {
  const text = readFileSync(file, "utf8");
  if (!pattern.test(text)) throw new Error(`${file}: no match for ${String(pattern)}`);
  writeFileSync(file, text.replace(pattern, replacement));
  console.log(`  ${file}`);
}

console.log(`Bumping to ${version}:`);
for (const pkg of ["core", "dataform", "bigquery", "action"]) {
  bump(`packages/${pkg}/package.json`, /"version": "[^"]+"/, `"version": "${version}"`);
}
bump(
  "packages/action/src/main.ts",
  /Dataform Cost Check \d+\.\d+\.\d+ \(alpha\)/,
  `Dataform Cost Check ${version} (alpha)`,
);
bump("README.md", /Status: alpha \(\d+\.\d+\.\d+\)/, `Status: alpha (${version})`);
bump("README.md", /@<commit SHA> # v\d+\.\d+\.\d+/, `@<commit SHA> # v${version}`);
bump("SECURITY.md", /<40-character SHA> # v\d+\.\d+\.\d+/, `<40-character SHA> # v${version}`);

execFileSync("pnpm", ["prettier", "--write", "README.md", "SECURITY.md"], { stdio: "ignore" });
execFileSync("pnpm", ["check"], { stdio: "inherit" });
execFileSync("pnpm", ["build"], { stdio: "inherit" });
console.log(`
Done. Next:
  1. Commit on a branch and open a PR ("Prepare ${version}"); it merges once CI passes.
  2. On main: git tag -a v${version} -m "Dataform Cost Check ${version}" && git push origin v${version}
  3. The release workflow checks, attests and publishes it, and moves the v${version.split(".")[0]} tag.`);
