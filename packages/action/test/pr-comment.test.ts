import { describe, expect, it } from "vitest";
import { findStickyComment, pullRequestFromEvent, upsertStickyComment } from "../src/pr-comment.ts";
import type { IssueComment, PullRequestContext } from "../src/pr-comment.ts";

const MARKER = "<!-- dataform-cost-check -->";

function prEvent(headRepo: string | null): unknown {
  return {
    pull_request: {
      number: 7,
      head: { repo: headRepo === null ? null : { full_name: headRepo } },
      base: { repo: { full_name: "acme/warehouse" } },
    },
  };
}

describe("pullRequestFromEvent", () => {
  it("reads a same-repository pull request", () => {
    expect(pullRequestFromEvent(prEvent("acme/warehouse"))).toEqual({
      repo: "acme/warehouse",
      number: 7,
      isFork: false,
    });
  });

  it("flags a fork, including one that was deleted", () => {
    expect(pullRequestFromEvent(prEvent("someone/warehouse"))?.isFork).toBe(true);
    expect(pullRequestFromEvent(prEvent(null))?.isFork).toBe(true);
  });

  it("returns undefined for other events", () => {
    expect(pullRequestFromEvent({ push: {} })).toBeUndefined();
    expect(pullRequestFromEvent(null)).toBeUndefined();
  });
});

describe("findStickyComment", () => {
  const human: IssueComment = { id: 1, body: "Looks costly", user: { type: "User" } };
  const quoted: IssueComment = { id: 2, body: `> ${MARKER}\n> quoted`, user: { type: "User" } };
  const byPerson: IssueComment = { id: 3, body: `${MARKER}\nold`, user: { type: "User" } };
  const byBot: IssueComment = { id: 4, body: `${MARKER}\nold`, user: { type: "Bot" } };

  it("finds nothing when no comment starts with the marker", () => {
    expect(findStickyComment([human, quoted], MARKER)).toBeUndefined();
  });

  it("prefers a bot's comment over a person's", () => {
    expect(findStickyComment([byPerson, byBot], MARKER)?.id).toBe(4);
  });

  it("falls back to any comment that starts with the marker", () => {
    expect(findStickyComment([human, byPerson], MARKER)?.id).toBe(3);
  });
});

describe("upsertStickyComment", () => {
  const pr: PullRequestContext = { repo: "acme/warehouse", number: 7, isFork: false };

  function fakeGitHub(pages: IssueComment[][]) {
    const calls: { method: string; url: string; body?: string | undefined }[] = [];
    const fetchFn = ((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body as string | undefined });
      if (method === "GET") {
        const page = Number(new URL(url).searchParams.get("page"));
        return Promise.resolve(Response.json(pages[page - 1] ?? []));
      }
      return Promise.resolve(
        Response.json({ html_url: "https://github.com/acme/warehouse/pull/7#c" }),
      );
    }) as typeof fetch;
    return { calls, fetchFn };
  }

  it("creates a comment when none exists", async () => {
    const gh = fakeGitHub([[]]);
    const result = await upsertStickyComment({
      token: "t",
      pr,
      body: `${MARKER}\nnew`,
      marker: MARKER,
      fetch: gh.fetchFn,
    });
    expect(result.action).toBe("created");
    expect(gh.calls.at(-1)).toMatchObject({
      method: "POST",
      url: "https://api.github.com/repos/acme/warehouse/issues/7/comments",
    });
  });

  it("follows pages and edits the existing comment in place", async () => {
    const full = Array.from({ length: 100 }, (_, i): IssueComment => ({ id: i, body: "hi" }));
    const gh = fakeGitHub([full, [{ id: 500, body: `${MARKER}\nold`, user: { type: "Bot" } }]]);
    const result = await upsertStickyComment({
      token: "t",
      pr,
      body: `${MARKER}\nnew`,
      marker: MARKER,
      fetch: gh.fetchFn,
    });
    expect(result.action).toBe("updated");
    expect(gh.calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(gh.calls.at(-1)).toMatchObject({
      method: "PATCH",
      url: "https://api.github.com/repos/acme/warehouse/issues/comments/500",
    });
    expect(JSON.parse(gh.calls.at(-1)?.body ?? "{}")).toEqual({ body: `${MARKER}\nnew` });
  });

  it("throws with the status when GitHub refuses", async () => {
    const fetchFn = (() => Promise.resolve(new Response("", { status: 403 }))) as typeof fetch;
    await expect(
      upsertStickyComment({ token: "t", pr, body: "b", marker: MARKER, fetch: fetchFn }),
    ).rejects.toThrow("returned 403");
  });
});
