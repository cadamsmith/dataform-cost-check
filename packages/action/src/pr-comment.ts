import { readFile } from "node:fs/promises";

/** The parts of a `pull_request` event payload the action needs. */
export interface PullRequestContext {
  /** `owner/name` of the repository the pull request targets. */
  readonly repo: string;
  readonly number: number;
  /**
   * True when the head branch lives in another repository. Fork pull requests get no
   * secrets and a read-only token, so the action reports nothing for them.
   */
  readonly isFork: boolean;
}

interface PullRequestEvent {
  pull_request?: {
    number?: number;
    head?: { repo?: { full_name?: string } | null };
    base?: { repo?: { full_name?: string } };
  };
}

/** Reads the pull request from an event payload; undefined when it is not a PR event. */
export function pullRequestFromEvent(event: unknown): PullRequestContext | undefined {
  const pr = (event as PullRequestEvent | null)?.pull_request;
  const repo = pr?.base?.repo?.full_name;
  if (pr?.number === undefined || repo === undefined) return undefined;
  // A deleted fork leaves head.repo null; treat it as a fork.
  const headRepo = pr.head?.repo?.full_name;
  return { repo, number: pr.number, isFork: headRepo !== repo };
}

export async function readPullRequestContext(
  eventPath: string | undefined,
): Promise<PullRequestContext | undefined> {
  if (!eventPath) return undefined;
  return pullRequestFromEvent(JSON.parse(await readFile(eventPath, "utf8")));
}

export interface IssueComment {
  readonly id: number;
  readonly body?: string | null;
  readonly user?: { readonly type?: string } | null;
}

/**
 * The comment to update: one whose body starts with the marker, preferring one written by
 * a bot (the default `github.token` posts as `github-actions[bot]`) over a person's.
 */
export function findStickyComment(
  comments: readonly IssueComment[],
  marker: string,
): IssueComment | undefined {
  const ours = comments.filter((c) => c.body?.startsWith(marker) === true);
  return ours.find((c) => c.user?.type === "Bot") ?? ours[0];
}

export interface PostCommentOptions {
  readonly token: string;
  readonly pr: PullRequestContext;
  readonly body: string;
  readonly marker: string;
  readonly apiUrl?: string | undefined;
  readonly fetch?: typeof fetch;
}

/** Creates the sticky comment, or edits it in place. Returns what it did. */
export async function upsertStickyComment(
  options: PostCommentOptions,
): Promise<{ action: "created" | "updated"; url: string }> {
  const { token, pr, body, marker } = options;
  const apiUrl = options.apiUrl ?? "https://api.github.com";
  const doFetch = options.fetch ?? fetch;
  const request = async (method: string, path: string, payload?: unknown): Promise<unknown> => {
    const response = await doFetch(`${apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${method} ${path} returned ${String(response.status)}`);
    }
    return response.json();
  };

  const comments: IssueComment[] = [];
  for (let page = 1; ; page++) {
    const batch = (await request(
      "GET",
      `/repos/${pr.repo}/issues/${String(pr.number)}/comments?per_page=100&page=${String(page)}`,
    )) as IssueComment[];
    comments.push(...batch);
    if (batch.length < 100) break;
  }

  const existing = findStickyComment(comments, marker);
  if (existing) {
    const updated = (await request(
      "PATCH",
      `/repos/${pr.repo}/issues/comments/${String(existing.id)}`,
      {
        body,
      },
    )) as { html_url: string };
    return { action: "updated", url: updated.html_url };
  }
  const created = (await request("POST", `/repos/${pr.repo}/issues/${String(pr.number)}/comments`, {
    body,
  })) as { html_url: string };
  return { action: "created", url: created.html_url };
}
