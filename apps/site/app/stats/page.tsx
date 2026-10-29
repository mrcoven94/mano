import type { Metadata } from "next";
import Link from "next/link";
import usageJson from "@/data/usage.json";
import historyJson from "@/data/history.json";
import { REPO_URL } from "@/lib/site";
import {
  filterRecordsSince,
  sinceDayForWindow,
  summarizeHistory,
  summarizeSessions,
  summarizeUsage,
  type HistoryFile,
  type UsageRecord,
} from "@mano/meter/stats";
import styles from "./stats.module.css";

const title = "Usage stats";
const description =
  "Which models answer for Mano, what it costs, how fast it answers, and who wrote the code. Plain numbers from the usage recorder and the build history.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/stats" },
  openGraph: { title, description },
};

const WINDOWS = [
  { key: "all", label: "All time", href: "/stats" },
  { key: "30", label: "Last 30 days", href: "/stats?days=30" },
  { key: "7", label: "Last 7 days", href: "/stats?days=7" },
];

const usageRecords = usageJson as unknown as UsageRecord[];
const historyFile = historyJson as unknown as HistoryFile;

function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

function formatShare(share: number | null): string {
  if (share === null) return "None recorded";
  return `${Math.round(share * 100)}%`;
}

function formatUsd(cost: number): string {
  if (cost < 1) return `$${cost.toFixed(4)}`;
  return `$${cost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatRange(range: { from: string; to: string } | null): string {
  if (range === null) return "no records in this range";
  if (range.from === range.to) return formatDay(range.from);
  return `${formatDay(range.from)} to ${formatDay(range.to)}`;
}

function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds === null) return "None recorded";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (hours === 0 && minutes === 0) return `${totalSeconds}s`;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

export default async function StatsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const params = await searchParams;
  const windowKey = params.days === "7" || params.days === "30" ? params.days : "all";
  const sinceDay = windowKey === "all" ? null : sinceDayForWindow(Number(windowKey));

  const usage = summarizeUsage(filterRecordsSince(usageRecords, sinceDay));
  const build = summarizeHistory(historyFile, sinceDay);
  const sessions = summarizeSessions(historyFile);
  const maxModelCalls = Math.max(0, ...usage.byModel.map((r) => r.calls));

  return (
    <div className={`wrap ${styles.page}`}>
      <div className={styles.head}>
        <p className="mono">Stats</p>
        <h1>Mano, in numbers.</h1>
        <p className="lede">
          Which models answer, what it costs, how fast it answers, and who wrote the code. Model names appear here so
          each number can say which model served it.
        </p>
        <nav className={styles.range} aria-label="Date range">
          {WINDOWS.map((w) => (
            <Link key={w.key} href={w.href} aria-current={w.key === windowKey ? "page" : undefined}>
              {w.label}
            </Link>
          ))}
        </nav>
        <p className={styles.coverage}>
          Usage: {formatRange(usage.range)} ({formatInt(usage.calls)} calls). Build history: {formatRange(build.range)}{" "}
          ({formatInt(build.prsOpened)} pull requests).
        </p>
      </div>

      <section className={styles.section} aria-labelledby="stats-models">
        <h2 id="stats-models">Models</h2>
        <p>Share of calls and tokens served by Meta models, in production and across all recorded traffic.</p>
        {usage.productionCalls === 0 ? (
          <p className={styles.notice}>
            No production calls recorded yet. The numbers below come from {formatInt(usage.calls)} test and CI
            records, never presented as production traffic.
          </p>
        ) : (
          <div className={styles.cards}>
            <div className={styles.card}>
              <b>{formatShare(usage.productionMetaCallShare)}</b>
              <span>of production calls on Meta models</span>
              <small>
                {formatInt(usage.productionCalls)} production calls, {formatInt(usage.productionTokens)} tokens
              </small>
            </div>
            <div className={styles.card}>
              <b>{formatShare(usage.productionMetaTokenShare)}</b>
              <span>of production tokens on Meta models</span>
            </div>
          </div>
        )}
        {usage.calls > 0 && (
          <>
            <div className={styles.cards}>
              <div className={styles.card}>
                <b>{formatShare(usage.metaCallShare)}</b>
                <span>of recorded calls on Meta models</span>
                <small>
                  {formatInt(usage.metaCalls)} of {formatInt(usage.calls)} calls
                </small>
              </div>
              <div className={styles.card}>
                <b>{formatShare(usage.metaTokenShare)}</b>
                <span>of recorded tokens on Meta models</span>
                <small>
                  {formatInt(usage.metaTokens)} of {formatInt(usage.tokens)} tokens
                </small>
              </div>
              <div className={styles.card}>
                <b>{formatUsd(usage.estimatedCostUsd)}</b>
                <span>estimated model cost</span>
                <small>from the meter rates table, not a bill</small>
              </div>
              <div className={styles.card}>
                <b>{usage.latencyP50Ms === null ? "None recorded" : `${formatInt(usage.latencyP50Ms)} ms`}</b>
                <span>median answer latency (p50)</span>
                <small>over {formatInt(usage.calls)} calls</small>
              </div>
              <div className={styles.card}>
                <b>{usage.latencyP95Ms === null ? "None recorded" : `${formatInt(usage.latencyP95Ms)} ms`}</b>
                <span>slow answers (p95)</span>
                <small>
                  {formatInt(usage.errors)} {usage.errors === 1 ? "error" : "errors"} in range
                </small>
              </div>
            </div>
            <ul className={styles.bars} aria-label="Calls by model">
              {usage.byModel.map((row, i) => (
                <li key={row.model}>
                  <code>{row.model}</code>
                  <span className={styles.track}>
                    <span
                      className={`${styles.fill} ${i === 1 ? styles.alt : i > 1 ? styles.third : ""}`}
                      style={{ display: "block", width: `${maxModelCalls === 0 ? 0 : (row.calls / maxModelCalls) * 100}%` }}
                    />
                  </span>
                  <span className={styles.val}>
                    {formatInt(row.calls)} calls, {formatInt(row.tokens)} tokens, {formatUsd(row.estimatedCostUsd)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className={styles.section} aria-labelledby="stats-built">
        <h2 id="stats-built">Built with</h2>
        <p>Who wrote the code, and how each change was reviewed before it merged.</p>
        <div className={styles.cards}>
          <div className={styles.card}>
            <b>{formatShare(build.museLineShare)}</b>
            <span>of changed lines by Muse</span>
            <small>
              {formatInt(build.linesByClass["muse-code"])} of {formatInt(build.lines)} lines
            </small>
          </div>
          <div className={styles.card}>
            <b>{formatShare(build.museCommitShare)}</b>
            <span>of commits by Muse</span>
            <small>
              {formatInt(build.commitsByClass["muse-code"])} of {formatInt(build.commits)} commits
            </small>
          </div>
          <div className={styles.card}>
            <b>{formatInt(build.reviewRounds)}</b>
            <span>architect review rounds</span>
            <small>
              {formatInt(build.multiModelReviews)} with a second model or panel
            </small>
          </div>
          <div className={styles.card}>
            <b>
              {formatInt(build.prsMerged)} <span style={{ fontSize: "1.1rem" }}>of {formatInt(build.prsOpened)}</span>
            </b>
            <span>pull requests merged</span>
            <small>average {formatDuration(build.avgOpenToMergeSeconds)} from open to merge</small>
          </div>
        </div>
        {build.lines > 0 && (
          <>
            <div className={styles.stack} role="img" aria-label="Changed lines by author">
              <span style={{ width: `${(build.linesByClass["muse-code"] / build.lines) * 100}%`, background: "var(--pen)" }} />
              <span style={{ width: `${(build.linesByClass.architect / build.lines) * 100}%`, background: "var(--green)" }} />
              <span style={{ width: `${(build.linesByClass.person / build.lines) * 100}%`, background: "var(--border2)" }} />
            </div>
            <ul className={styles.legend}>
              <li>
                <i style={{ background: "var(--pen)" }} />
                Muse ({formatInt(build.linesByClass["muse-code"])} lines)
              </li>
              <li>
                <i style={{ background: "var(--green)" }} />
                Architect ({formatInt(build.linesByClass.architect)} lines)
              </li>
              <li>
                <i style={{ background: "var(--border2)" }} />
                Person ({formatInt(build.linesByClass.person)} lines)
              </li>
            </ul>
          </>
        )}
        {sessions.length > 0 && (
          <div className={styles.tablewrap}>
            <table>
              <caption className="sr-only">Whole project by session, all time</caption>
              <thead>
                <tr>
                  <th scope="col">Session</th>
                  <th scope="col" className={styles.num}>Lines</th>
                  <th scope="col" className={styles.num}>Commits</th>
                  <th scope="col" className={styles.num}>PRs merged</th>
                  <th scope="col" className={styles.num}>Review rounds</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.session}>
                    <td>{s.session}</td>
                    <td className={styles.num}>{formatInt(s.lines)}</td>
                    <td className={styles.num}>{formatInt(s.commits)}</td>
                    <td className={styles.num}>{formatInt(s.prsMerged)}</td>
                    <td className={styles.num}>{formatInt(s.reviewRounds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.source} aria-labelledby="stats-source">
        <h2 id="stats-source">Where these numbers come from</h2>
        <ul>
          <li>
            Usage numbers come from {formatInt(usageRecords.length)} records captured by the usage recorder through
            the channels responder in its production record shape, plus the CI run of{" "}
            {formatRange(summarizeUsage(usageRecords).range)}. All recorded traffic so far is test traffic; production
            writes go to the mano_model_usage Analytics Engine dataset, and none have arrived yet.
          </li>
          <li>
            Cost is an estimate from the rates table in <code>packages/meter/src/rates.ts</code>, not a bill. Latency
            is measured end to end through the responder.
          </li>
          <li>
            Build numbers come from the meter history report generated{" "}
            {historyFile.generatedAt === null ? "at an unknown time" : historyFile.generatedAt.slice(0, 10)} from git
            history and {formatInt(historyFile.prs.length)} pull requests through the GitHub API. It keeps counts
            only: no titles, bodies or commit hashes. A review round is a repo-owner comment that reads as an
            architect review; a multi-model review is one that mentions a second model or a panel.
          </li>
          <li>
            Snapshots live in <code>apps/site/data</code> and are pinned by tests: the channels fixture test fails if
            the usage files drift from fresh recorder output, and the meter tests fail if either snapshot turns
            inconsistent. The recorder and collector are open source in{" "}
            <a href={`${REPO_URL}/tree/main/packages/meter`}>packages/meter</a>.
          </li>
        </ul>
      </section>
    </div>
  );
}
