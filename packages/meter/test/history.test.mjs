import { describe, expect, it } from "vitest";
import {
  COMMITS_BODY_FORMAT,
  COMMITS_FORMAT,
  NUMSTAT_FORMAT,
  UNPREFIXED,
  addCommits,
  addPrs,
  classifyCommit,
  dayOfUnix,
  emptySummary,
  isArchitectReview,
  isMultiModelReview,
  joinCommits,
  parseCommitBodies,
  parseCommitList,
  parseNumstat,
  r2HistoryKey,
  sessionFromTitle,
  summarizePr,
} from "../history/aggregate.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("sessionFromTitle", () => {
  it("takes the [Session] prefix", () => {
    expect(sessionFromTitle("[Channels] LAP-508: texts")).toBe("Channels");
    expect(sessionFromTitle("  [Site] LAP-496: pages")).toBe("Site");
  });
  it("falls back to unprefixed", () => {
    expect(sessionFromTitle("AGENTS.md: how work ships")).toBe(UNPREFIXED);
    expect(sessionFromTitle("")).toBe(UNPREFIXED);
    expect(sessionFromTitle("[] empty")).toBe(UNPREFIXED);
  });
});

describe("classifyCommit", () => {
  it("spots the Muse Code trailer in either case", () => {
    expect(classifyCommit("fix\n\nCo-Authored-By: Muse Code <noreply@muse.dev>")).toBe("muse-code");
    expect(classifyCommit("fix\n\nCo-authored-by: Muse Code <noreply@muse.dev>")).toBe("muse-code");
  });
  it("spots the architect trailer in either case", () => {
    expect(classifyCommit("fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>")).toBe(
      "architect",
    );
    expect(classifyCommit("fix\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>")).toBe(
      "architect",
    );
  });
  it("prefers muse-code when both trailers appear, person otherwise", () => {
    expect(
      classifyCommit("Co-Authored-By: Muse Code <a>\nCo-Authored-By: Claude <b>"),
    ).toBe("muse-code");
    expect(classifyCommit("a plain human commit")).toBe("person");
    expect(classifyCommit("bump\n\nCo-authored-by: dependabot[bot] <b>")).toBe("person");
    expect(classifyCommit(undefined)).toBe("person");
  });
});

describe("dayOfUnix", () => {
  it("buckets by UTC day", () => {
    expect(dayOfUnix(1793145600)).toBe("2026-10-28");
    expect(dayOfUnix("1793145600")).toBe("2026-10-28");
  });
});

describe("review detection", () => {
  const first = "Review of a771ed0 (Claude, architect, plus Sol 6.1 and a two-model panel).";
  const second = "Second review, of ef86161 (Claude, architect, plus Sol 6.1).";
  const finalCheck = "Final check of 03903df (Claude, architect, plus Sol 6.1).";
  const panelOnly = "Review of x (Claude, architect, with a three-model panel).";
  const update = "[Channels] All 8 blockers are done in ef86161. Requesting re-review.";
  const merge = "Merging ce2019e: custom domain set, CI green.";

  it("counts architect review rounds", () => {
    expect(isArchitectReview(first)).toBe(true);
    expect(isArchitectReview(second)).toBe(true);
    expect(isArchitectReview(finalCheck)).toBe(true);
    expect(isArchitectReview(update)).toBe(false);
    expect(isArchitectReview(merge)).toBe(false);
  });
  it("counts multi-model reviews only when Sol 6.1 or a panel is named", () => {
    expect(isMultiModelReview(first)).toBe(true);
    expect(isMultiModelReview(second)).toBe(true);
    expect(isMultiModelReview(finalCheck)).toBe(true);
    expect(isMultiModelReview(panelOnly)).toBe(true);
    expect(isMultiModelReview("Review of x (Claude, architect). Looks good.")).toBe(false);
    expect(isMultiModelReview(update)).toBe(false);
  });
});

describe("git parsers", () => {
  it("exposes the formats the collector passes to git log", () => {
    expect(COMMITS_FORMAT).toContain("%H");
    expect(COMMITS_BODY_FORMAT).toContain("%B");
    expect(NUMSTAT_FORMAT).toContain("%H");
  });
  it("parses the commit list pass", () => {
    const out = [
      `COMMIT ${SHA_A} 1793145600 [Channels] LAP-508: texts (#41)`,
      `COMMIT ${SHA_B} 1793232000 AGENTS.md: how work ships`,
      "",
    ].join("\n");
    expect(parseCommitList(out)).toEqual([
      { sha: SHA_A, day: "2026-10-28", session: "Channels" },
      { sha: SHA_B, day: "2026-10-29", session: UNPREFIXED },
    ]);
  });
  it("parses the NUL-separated bodies pass", () => {
    const out = `\0${SHA_A}\nsubject\n\nCo-Authored-By: Muse Code <a>\0${SHA_B}\nplain\n`;
    const bodies = parseCommitBodies(out);
    expect(bodies.get(SHA_A)).toContain("Muse Code");
    expect(bodies.get(SHA_B)).toBe("plain\n");
  });
  it("sums numstat lines and skips binary files", () => {
    const out = [
      `COMMIT ${SHA_A}`,
      "10\t3\tsrc/a.ts",
      "-\t-\timg.png",
      `COMMIT ${SHA_B}`,
      "0\t7\tsrc/b.ts",
      "",
    ].join("\n");
    expect(parseNumstat(out)).toEqual(
      new Map([
        [SHA_A, 13],
        [SHA_B, 7],
      ]),
    );
  });
  it("joins the three passes into commit rows", () => {
    const list = [
      { sha: SHA_A, day: "2026-10-28", session: "Channels" },
      { sha: SHA_B, day: "2026-10-28", session: "Channels" },
    ];
    const bodies = new Map([[SHA_A, "x\n\nCo-Authored-By: Muse Code <a>"]]);
    const numstat = new Map([[SHA_A, 13]]);
    expect(joinCommits(list, bodies, numstat)).toEqual([
      { day: "2026-10-28", session: "Channels", authorClass: "muse-code", lines: 13 },
      { day: "2026-10-28", session: "Channels", authorClass: "person", lines: 0 },
    ]);
  });
});

describe("summarizePr", () => {
  const owner = "mrcoven94";
  function detail(bodies) {
    return {
      comments: bodies.map((body, i) => ({
        author: { login: i === bodies.length - 1 ? "vercel" : owner },
        body,
      })),
      reviews: [],
    };
  }
  it("measures open-to-merge seconds and review rounds", () => {
    const row = summarizePr(
      {
        number: 41,
        title: "[Channels] LAP-508: texts",
        state: "MERGED",
        createdAt: "2026-10-28T19:12:10Z",
        mergedAt: "2026-10-28T22:14:34Z",
      },
      detail([
        "Review of a (Claude, architect, plus Sol 6.1 and a two-model panel).",
        "[Channels] fixes are in.",
        "Second review, of b (Claude, architect).",
        "deploy preview",
      ]),
      owner,
    );
    expect(row).toMatchObject({
      number: 41,
      session: "Channels",
      state: "MERGED",
      openedDay: "2026-10-28",
      mergedDay: "2026-10-28",
      openToMergeSeconds: 10944,
      comments: 4,
      ownerComments: 3,
      reviewRounds: 2,
      multiModelReviews: 1,
    });
    expect(row.formalReviews).toEqual({ approved: 0, changesRequested: 0, commented: 0, dismissed: 0 });
  });
  it("leaves merge fields null on open PRs and counts formal reviews", () => {
    const row = summarizePr(
      { number: 52, title: "[App] LAP-519: app", state: "OPEN", createdAt: "2026-10-28T21:36:57Z" },
      {
        comments: [],
        reviews: [{ state: "APPROVED" }, { state: "CHANGES_REQUESTED" }, { state: "COMMENTED" }],
      },
      owner,
    );
    expect(row.mergedDay).toBeNull();
    expect(row.openToMergeSeconds).toBeNull();
    expect(row.formalReviews).toEqual({
      approved: 1,
      changesRequested: 1,
      commented: 1,
      dismissed: 0,
    });
  });
});

describe("aggregation", () => {
  it("buckets commits per day and per session", () => {
    const summary = emptySummary("o/r");
    addCommits(summary, [
      { day: "2026-10-28", session: "Channels", authorClass: "muse-code", lines: 100 },
      { day: "2026-10-28", session: "Channels", authorClass: "person", lines: 5 },
      { day: "2026-10-29", session: "Site", authorClass: "architect", lines: 20 },
    ]);
    expect(summary.days["2026-10-28"].commits).toEqual({
      "muse-code": 1,
      architect: 0,
      person: 1,
    });
    expect(summary.days["2026-10-28"].lines["muse-code"]).toBe(100);
    expect(summary.sessions["Site"].commits.architect).toBe(1);
    expect(summary.sessions["Site"].lines.architect).toBe(20);
  });
  it("rolls PRs into days, sessions and a sorted pr list", () => {
    const summary = emptySummary("o/r");
    addPrs(summary, [
      {
        number: 2,
        session: "Channels",
        state: "MERGED",
        openedDay: "2026-10-28",
        mergedDay: "2026-10-28",
        openToMergeSeconds: 100,
        comments: 1,
        ownerComments: 1,
        reviewRounds: 1,
        multiModelReviews: 1,
        formalReviews: { approved: 0, changesRequested: 0, commented: 0, dismissed: 0 },
      },
      {
        number: 1,
        session: "Channels",
        state: "MERGED",
        openedDay: "2026-10-28",
        mergedDay: "2026-10-29",
        openToMergeSeconds: 200,
        comments: 0,
        ownerComments: 0,
        reviewRounds: 0,
        multiModelReviews: 0,
        formalReviews: { approved: 1, changesRequested: 0, commented: 0, dismissed: 0 },
      },
    ]);
    expect(summary.prs.map((pr) => pr.number)).toEqual([1, 2]);
    expect(summary.days["2026-10-28"].prsOpened).toBe(2);
    expect(summary.days["2026-10-28"].prsMerged).toBe(1);
    expect(summary.days["2026-10-29"].prsMerged).toBe(1);
    const session = summary.sessions["Channels"];
    expect(session.prsOpened).toBe(2);
    expect(session.prsMerged).toBe(2);
    expect(session.reviewRounds).toBe(1);
    expect(session.multiModelReviews).toBe(1);
    expect(session.openToMergeSeconds).toEqual({ count: 2, total: 300, avg: 150 });
  });
  it("builds the R2 history key under the meter prefix", () => {
    expect(r2HistoryKey("meter/", "2026-10-29")).toBe("meter/history/2026-10-29.json");
    expect(r2HistoryKey("meter", "2026-10-29")).toBe("meter/history/2026-10-29.json");
  });
});

describe("counts only", () => {
  it("keeps bodies, titles and SHAs out of the summary", () => {
    const sentinels = ["SENTINEL_BODY", "SENTINEL_TITLE", SHA_A, "+15551234567"];
    const summary = emptySummary("o/r");
    addCommits(
      summary,
      joinCommits(
        [{ sha: SHA_A, day: "2026-10-28", session: sessionFromTitle(`[S] ${sentinels[1]}`) }],
        new Map([[SHA_A, `fix ${sentinels[0]} ${sentinels[3]}\n\nCo-Authored-By: Muse Code <a>`]]),
        new Map([[SHA_A, 9]]),
      ),
    );
    addPrs(summary, [
      summarizePr(
        { number: 7, title: `[S] ${sentinels[1]}`, state: "OPEN", createdAt: "2026-10-28T00:00:00Z" },
        { comments: [{ author: { login: "o" }, body: `note ${sentinels[0]} ${sentinels[3]}` }], reviews: [] },
        "o",
      ),
    ]);
    const json = JSON.stringify(summary);
    for (const sentinel of sentinels) expect(json).not.toContain(sentinel);
    expect(Object.keys(summary.prs[0]).sort()).toEqual(
      [
        "comments",
        "formalReviews",
        "mergedDay",
        "multiModelReviews",
        "number",
        "openToMergeSeconds",
        "openedDay",
        "ownerComments",
        "reviewRounds",
        "session",
        "state",
      ].sort(),
    );
  });
});
