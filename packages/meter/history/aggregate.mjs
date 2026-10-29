// @mano/meter history: pure aggregation for the nightly history report.
//
// The collector (./collect.mjs, plain node, no deps) reads git history and
// the GitHub API through `gh`, then folds everything through the functions
// here into one summary JSON object. Counts only: commits and added plus
// deleted lines per day and per session, PRs opened and merged, review
// rounds per PR, multi-model reviews, and PR open-to-merge seconds. Commit
// messages, PR titles, bodies and SHAs never reach the output.
//
// Author classes: a commit whose body carries a "Co-Authored-By: Muse Code"
// trailer counts as muse-code; a "Co-Authored-By: Claude" trailer counts as
// architect (a commit with both counts as muse-code); anything else,
// including bots, counts as person. A session is the "[Name]" prefix of a
// commit subject or PR title when it matches SESSION_ALLOWLIST, "other"
// for any other bracket text, or "unprefixed" when there is none.
//
// A review round is a PR comment written by the repo owner that reads as an
// architect review: its body matches REVIEW_PATTERN below. A multi-model
// review is a review round whose body mentions MULTI_MODEL_PATTERN (Sol 6.1
// or a panel). Formal GitHub reviews (the reviews API) are counted by state
// separately; on this repo most review happens in comments.

export const UNPREFIXED = "unprefixed";

// Bracket text that is not a known session. Titles are content, so a
// session name only enters the report when it matches this list.
export const OTHER_SESSION = "other";

export const SESSION_ALLOWLIST = [
  "Engine",
  "Channels",
  "Mail",
  "Forms",
  "Guardian",
  "Eval",
  "Quality",
  "Ship",
  "App",
  "Accounts",
  "Meter",
  "Agent",
];

export const AUTHOR_CLASSES = ["muse-code", "architect", "person"];

// Owner comments matching this count as architect review rounds.
export const REVIEW_PATTERN =
  /\(claude,\s*architect|^review of |^(second|third|fourth|fifth) review|^final check/im;

// Review rounds matching this count as multi-model reviews.
export const MULTI_MODEL_PATTERN = /sol\s*6\.1|panel/i;

export function sessionFromTitle(title) {
  const match = /^\s*\[([^\]]+)\]/.exec(title ?? "");
  const name = match ? match[1].trim() : "";
  if (name === "") return UNPREFIXED;
  return SESSION_ALLOWLIST.includes(name) ? name : OTHER_SESSION;
}

export function classifyCommit(body) {
  const text = body ?? "";
  if (/co-authored-by:\s*muse code/im.test(text)) return "muse-code";
  if (/co-authored-by:\s*claude/im.test(text)) return "architect";
  return "person";
}

export function dayOfUnix(ts) {
  return new Date(Number(ts) * 1000).toISOString().slice(0, 10);
}

export function isArchitectReview(body) {
  return REVIEW_PATTERN.test(body ?? "");
}

export function isMultiModelReview(body) {
  return isArchitectReview(body) && MULTI_MODEL_PATTERN.test(body ?? "");
}

export function emptyClassCounts() {
  return { "muse-code": 0, architect: 0, person: 0 };
}

function emptyDay() {
  return { commits: emptyClassCounts(), lines: emptyClassCounts(), prsOpened: 0, prsMerged: 0 };
}

function emptySession() {
  return {
    commits: emptyClassCounts(),
    lines: emptyClassCounts(),
    prsOpened: 0,
    prsMerged: 0,
    reviewRounds: 0,
    multiModelReviews: 0,
    openToMergeSeconds: { count: 0, total: 0, avg: null },
  };
}

// commits: [{ day, session, authorClass, lines }]. Mutates summary.
export function addCommits(summary, commits) {
  for (const commit of commits) {
    const day = (summary.days[commit.day] ??= emptyDay());
    day.commits[commit.authorClass] += 1;
    day.lines[commit.authorClass] += commit.lines;
    const session = (summary.sessions[commit.session] ??= emptySession());
    session.commits[commit.authorClass] += 1;
    session.lines[commit.authorClass] += commit.lines;
  }
}

// prs: [{ number, session, state, openedDay, mergedDay, openToMergeSeconds,
// comments, ownerComments, reviewRounds, multiModelReviews, formalReviews }].
// Mutates summary.
export function addPrs(summary, prs) {
  for (const pr of prs) {
    summary.prs.push({
      number: pr.number,
      session: pr.session,
      state: pr.state,
      openedDay: pr.openedDay,
      mergedDay: pr.mergedDay,
      openToMergeSeconds: pr.openToMergeSeconds,
      comments: pr.comments,
      ownerComments: pr.ownerComments,
      reviewRounds: pr.reviewRounds,
      multiModelReviews: pr.multiModelReviews,
      formalReviews: pr.formalReviews,
    });
    const opened = (summary.days[pr.openedDay] ??= emptyDay());
    opened.prsOpened += 1;
    if (pr.mergedDay !== null) {
      const merged = (summary.days[pr.mergedDay] ??= emptyDay());
      merged.prsMerged += 1;
    }
    const session = (summary.sessions[pr.session] ??= emptySession());
    session.prsOpened += 1;
    if (pr.mergedDay !== null) session.prsMerged += 1;
    session.reviewRounds += pr.reviewRounds;
    session.multiModelReviews += pr.multiModelReviews;
    if (pr.openToMergeSeconds !== null) {
      const otm = session.openToMergeSeconds;
      otm.count += 1;
      otm.total += pr.openToMergeSeconds;
      otm.avg = Math.round(otm.total / otm.count);
    }
  }
  summary.prs.sort((a, b) => a.number - b.number);
}

export function emptySummary(repo) {
  return { generatedAt: null, repo, days: {}, sessions: {}, prs: [] };
}

// Parse `git log --no-merges --format=<FORMAT>` output where FORMAT prints
// one line "COMMIT <sha> <unix-ts> <subject>" per commit. Returns [{ sha,
// day, session }]. Bodies come from a second pass (see COMMITS_BODY_FORMAT).
export const COMMITS_FORMAT = "COMMIT %H %at %s";

export function parseCommitList(output) {
  const commits = [];
  for (const line of output.split("\n")) {
    const match = /^COMMIT ([0-9a-f]{40}) (\d+) ?(.*)$/.exec(line);
    if (!match) continue;
    commits.push({
      sha: match[1],
      day: dayOfUnix(match[2]),
      session: sessionFromTitle(match[3]),
    });
  }
  return commits;
}

// Second pass: full bodies so classifyCommit can see trailers. NUL-separated
// records ("%x00"), each "SHA\n<body>".
export const COMMITS_BODY_FORMAT = "%x00%H%n%B";

export function parseCommitBodies(output) {
  const bodies = new Map();
  for (const record of output.split("\0")) {
    const lineEnd = record.indexOf("\n");
    if (lineEnd < 40) continue;
    const sha = record.slice(0, lineEnd).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    bodies.set(sha, record.slice(lineEnd + 1));
  }
  return bodies;
}

// Parse `git log --no-merges --format=<NUMSTAT_FORMAT> --numstat` output.
// NUMSTAT_FORMAT prints one line "COMMIT <sha>" per commit, followed by its
// numstat lines ("<added>\t<deleted>\t<path>", "-" for binary, skipped).
export const NUMSTAT_FORMAT = "COMMIT %H";

export function parseNumstat(output) {
  const lines = new Map();
  let current = null;
  for (const line of output.split("\n")) {
    const commit = /^COMMIT ([0-9a-f]{40})$/.exec(line);
    if (commit) {
      current = commit[1];
      if (!lines.has(current)) lines.set(current, 0);
      continue;
    }
    const stat = /^(\d+)\t(\d+)\t/.exec(line);
    if (stat && current !== null) {
      lines.set(current, (lines.get(current) ?? 0) + Number(stat[1]) + Number(stat[2]));
    }
  }
  return lines;
}

// Join the three git passes into commit rows for addCommits.
export function joinCommits(list, bodies, numstat) {
  return list.map((entry) => ({
    day: entry.day,
    session: entry.session,
    authorClass: classifyCommit(bodies.get(entry.sha)),
    lines: numstat.get(entry.sha) ?? 0,
  }));
}

// Fold one PR's `gh pr view --json comments,reviews` payload into counts.
// ownerLogin: repo owner; only their comments can be review rounds. Bodies
// are read here and dropped: the result holds counts only.
export function summarizePr(pr, detail, ownerLogin) {
  const openedDay = (pr.createdAt ?? "").slice(0, 10);
  const mergedDay = pr.mergedAt ? pr.mergedAt.slice(0, 10) : null;
  let openToMergeSeconds = null;
  if (pr.createdAt && pr.mergedAt) {
    openToMergeSeconds = Math.max(
      0,
      Math.round((Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 1000),
    );
  }
  let ownerComments = 0;
  let reviewRounds = 0;
  let multiModelReviews = 0;
  const comments = detail.comments ?? [];
  for (const comment of comments) {
    if (comment.author?.login !== ownerLogin) continue;
    ownerComments += 1;
    if (isArchitectReview(comment.body)) reviewRounds += 1;
    if (isMultiModelReview(comment.body)) multiModelReviews += 1;
  }
  const formalReviews = { approved: 0, changesRequested: 0, commented: 0, dismissed: 0 };
  for (const review of detail.reviews ?? []) {
    if (review.state === "APPROVED") formalReviews.approved += 1;
    else if (review.state === "CHANGES_REQUESTED") formalReviews.changesRequested += 1;
    else if (review.state === "COMMENTED") formalReviews.commented += 1;
    else if (review.state === "DISMISSED") formalReviews.dismissed += 1;
  }
  return {
    number: pr.number,
    session: sessionFromTitle(pr.title),
    state: pr.state,
    openedDay,
    mergedDay,
    openToMergeSeconds,
    comments: comments.length,
    ownerComments,
    reviewRounds,
    multiModelReviews,
    formalReviews,
  };
}

export function r2HistoryKey(prefix, day) {
  const clean = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return `${clean}history/${day}.json`;
}
