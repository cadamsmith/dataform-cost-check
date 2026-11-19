import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The commit to compare against: the `base-ref` input if set, otherwise the pull
 * request's base SHA from the event payload.
 */
export async function resolveBaseRef(
  input: string,
  eventPath: string | undefined,
): Promise<string> {
  if (input) return input;
  if (eventPath) {
    const event = JSON.parse(await readFile(eventPath, "utf8")) as {
      pull_request?: { base?: { sha?: string } };
    };
    const sha = event.pull_request?.base?.sha;
    if (sha) return sha;
  }
  throw new Error("No base commit: set the base-ref input, or run on a pull_request event.");
}

/**
 * Check out `ref` into a temporary git worktree, call `fn` with its path, then remove it.
 * The base commit must be in the local clone, so `actions/checkout` needs `fetch-depth: 0`
 * (or a fetch of the base SHA).
 */
export async function withBaseWorktree<T>(
  repoDir: string,
  ref: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = join(await mkdtemp(join(tmpdir(), "dataform-cost-check-")), "base");
  try {
    await execFileAsync("git", ["-C", repoDir, "worktree", "add", "--detach", dir, ref]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not check out base commit ${ref}. With actions/checkout, set fetch-depth: 0. ${detail}`,
      { cause: error },
    );
  }
  try {
    return await fn(dir);
  } finally {
    await execFileAsync("git", ["-C", repoDir, "worktree", "remove", "--force", dir]).catch(() =>
      rm(dir, { recursive: true, force: true }),
    );
  }
}
