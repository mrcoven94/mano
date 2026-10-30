import type { Metadata } from "next";
import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { stripModelNames } from "@mano/quality/site";
import { loadQuality, type HistoryRow, type RunReport, type StaffCaseRow } from "@/lib/quality";
import Chart, { SERIES_COLORS, type Series } from "./Chart";
import TokenForm from "./TokenForm";
import styles from "./quality.module.css";

export const metadata: Metadata = {
  title: "Quality",
  description: "Staff view of Mano's answer quality: the nightly run, trends, weakest answers and failed checks.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function signedIn(stored: string | undefined): boolean {
  const expected = process.env.QUALITY_STAFF_TOKEN ?? "";
  if (!expected || !stored) return false;
  const x = Buffer.from(stored);
  const y = Buffer.from(expected);
  return x.length === y.length && timingSafeEqual(x, y);
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const pct1 = (n: number) => `${(n * 100).toFixed(1)}%`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const score = (n: number) => n.toFixed(2);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const SUITE_NAMES: Record<string, string> = {
  chat: "Chat questions",
  text: "Texts",
  letters: "Letters",
  safety: "Safety",
  "safety-holdout": "Safety holdout",
  personas: "Personas",
};

function liveSuites(r: RunReport) {
  return Object.values(r.suites).filter((s) => (s.liveCases ?? 0) > 0);
}

function weighted(r: RunReport, pick: (s: RunReport["suites"][string]) => number): number {
  const live = liveSuites(r);
  const n = live.reduce((sum, s) => sum + (s.liveCases ?? 0), 0);
  return n === 0 ? 0 : live.reduce((sum, s) => sum + pick(s) * (s.liveCases ?? 0), 0) / n;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className={`wrap ${styles.page}`}>
      <h1 className={styles.title}>Quality</h1>
      {children}
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className={`${styles.tile} ${tone ? styles[tone] : ""}`}>
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>{value}</div>
      {sub ? <div className={styles.sub}>{sub}</div> : null}
    </div>
  );
}

function Bubbles({ c }: { c: StaffCaseRow }) {
  return (
    <div className={styles.bubbles}>
      {c.bubbles.map((b, i) => (
        <div key={i} className={styles.bubble}>{b}</div>
      ))}
    </div>
  );
}

function trendSeries(history: HistoryRow[], suites: string[], pick: (s: HistoryRow["suites"][string]) => number | null): Series[] {
  return suites.map((name) => ({
    name: SUITE_NAMES[name] ?? name,
    values: history.map((h) => {
      const s = h.suites[name];
      return s && s.liveCases > 0 ? pick(s) : null;
    }),
  }));
}

// Each live suite at the latest run: cost per 1,000 answers (or tokens per
// answer when rates are unset) across, judge mean up.
function CostQuality({ latest }: { latest: RunReport }) {
  const configured = latest.prices.configured;
  const points = liveSuites(latest).map((s) => ({
    name: SUITE_NAMES[s.suite] ?? s.suite,
    x: configured ? s.usdPer1kAnswers : (s.inputTokens + s.outputTokens) / Math.max(1, s.cases),
    y: s.judgeMean,
  }));
  const W = 420;
  const H = 220;
  const P = { l: 40, r: 14, t: 12, b: 30 };
  const xs = points.map((p) => p.x);
  const xmin = xs.length ? Math.min(...xs) * 0.8 : 0;
  const xmax = xs.length ? Math.max(...xs) * 1.2 : 1;
  const x = (v: number) => P.l + ((v - xmin) / Math.max(1e-9, xmax - xmin)) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - (v - 1) / 4) * (H - P.t - P.b);
  return (
    <div className={styles.chart} style={{ maxWidth: 520 }}>
      <h3>Cost against quality</h3>
      <p className={styles.now}>
        {configured ? "Cost per 1,000 answers across, judge mean up." : "Price rates are unset, so cost is shown as estimated tokens per answer, across. Judge mean up."}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cost against judge mean per suite">
        {[1, 2, 3, 4, 5].map((v) => (
          <g key={v}>
            <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="var(--border)" />
            <text x={P.l - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="var(--faint)">{v}</text>
          </g>
        ))}
        <text x={W - P.r} y={H - 8} textAnchor="end" fontSize="10" fill="var(--faint)">
          {configured ? `$${xmax.toFixed(2)} per 1k` : `${Math.round(xmax)} tokens`}
        </text>
        <text x={P.l} y={H - 8} fontSize="10" fill="var(--faint)">
          {configured ? `$${xmin.toFixed(2)}` : `${Math.round(xmin)} tokens`}
        </text>
        {points
          .map((p, i) => ({ ...p, color: SERIES_COLORS[i % SERIES_COLORS.length] }))
          .sort((a, b) => a.x - b.x)
          .map((p, i) => {
            const right = x(p.x) > W * 0.6;
            return (
              <g key={p.name}>
                <circle cx={x(p.x)} cy={y(p.y)} r="5" fill={p.color} />
                <text x={x(p.x) + (right ? -8 : 8)} y={y(p.y) + (i % 2 === 0 ? -8 : 16)} textAnchor={right ? "end" : "start"} fontSize="11" fill="var(--text)">
                  {p.name} {p.y.toFixed(2)}
                </text>
              </g>
            );
          })}
      </svg>
    </div>
  );
}

export default async function QualityPage() {
  const jar = await cookies();
  if (!signedIn(jar.get("mano_staff")?.value)) {
    return (
      <Shell>
        <div style={{ marginTop: 24 }}>
          {process.env.QUALITY_STAFF_TOKEN ? <TokenForm /> : <p>Staff sign-in for this page is not configured yet.</p>}
        </div>
      </Shell>
    );
  }

  const result = await loadQuality();
  if (result.state !== "ok") {
    const message = {
      unconfigured: "The runs store is not connected. Set the R2 read keys for this site.",
      empty: "No nightly run has been recorded yet. The first one lands here.",
      error: "The runs store did not answer. Try again in a minute.",
    }[result.state];
    return (
      <Shell>
        <p className={styles.runline}>{message}</p>
      </Shell>
    );
  }

  const { latest, failureDetails, history, lowest, failed, casesConnected, standins } = result.data;
  const row = history.find((h) => h.runId === latest.runId) ?? null;
  const suites = Object.keys(latest.suites);
  const live = liveSuites(latest);
  const liveNames = live.map((s) => s.suite);
  const labels = history.map((h) => day(h.startedAt));
  const probes = latest.probes;
  const guardian = latest.guardian;
  const mail = latest.mail;
  const knownFailures = [
    ...Object.values(latest.suites).flatMap((s) => s.gateFailures.map((f) => ({ id: `${f.caseId} ${f.check}`, detail: failureDetails[`${f.caseId} ${f.check}`] ?? "" }))),
    ...(probes?.failures ?? [])
      .filter((f) => f.failed.some((x) => x.startsWith("crisis-") || x === "false-crisis"))
      .map((f) => ({ id: `probe ${f.id}`, detail: f.failed.join(", ") })),
  ].map((k) => ({ id: k.id, detail: stripModelNames(k.detail) }));
  const safetyFailures = (row?.safety.failures ?? 0) + (probes?.failures.filter((f) => f.failed.some((x) => x.startsWith("crisis-") || x === "false-crisis")).length ?? 0);
  const traits = {
    helpful: weighted(latest, (s) => s.traits?.helpful ?? 0),
    accurate: weighted(latest, (s) => s.traits?.accurate ?? 0),
    plain: weighted(latest, (s) => s.traits?.plain ?? 0),
    warm: weighted(latest, (s) => s.traits?.warm ?? 0),
  };
  const tokensPerAnswer = live.reduce((sum, s) => sum + s.inputTokens + s.outputTokens, 0) / Math.max(1, live.reduce((sum, s) => sum + s.cases, 0));

  return (
    <Shell>
      <p className={styles.runline}>
        Nightly run of {day(latest.startedAt)}, {latest.caseCount} synthetic cases
        {latest.gitSha ? `, commit ${latest.gitSha.slice(0, 7)}` : ""}.{" "}
        {latest.promotion
          ? latest.promotion.promoted
            ? latest.promotion.accepted
              ? "Accepted as the baseline on purpose, despite a regression."
              : `Pull requests are gated against this run${latest.promotion.agentPromoted ? "" : "; the previous agent record is kept"}.`
            : latest.restoredFrom
              ? `Pull requests are gated against the restored run ${latest.restoredFrom.runId}.`
              : "This run did not become the baseline; pull requests are still gated against the previous one."
          : latest.eligibility.eligible ? "Pull requests are gated against this run." : `Not used as a gate baseline: ${latest.eligibility.reasons.join("; ")}.`}
      </p>

      {latest.restoredFrom ? (
        <div className={styles.alert} role="status">
          <b>Baseline restored.</b> Pull requests are gated against run {latest.restoredFrom.runId}, restored on {day(latest.restoredFrom.at)}, not against this run.
        </div>
      ) : latest.promotion && !latest.promotion.promoted && latest.promotion.reasons.length > 0 ? (
        <div className={styles.alert} role="alert">
          <b>Not promoted.</b> This run regressed against the baseline, so it was recorded but did not replace it:
          <ul>
            {latest.promotion.reasons.map((r) => <li key={r}>{stripModelNames(r)}</li>)}
          </ul>
        </div>
      ) : null}

      {knownFailures.length > 0 ? (
        <div className={styles.alert} role="alert">
          <b>Safety failures on main.</b> Pull requests are not failed for these, only for new ones. Fix them here:
          <ul>
            {knownFailures.map((k) => (
              <li key={k.id}><code>{k.id}</code> {k.detail}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={styles.tiles}>
        <Tile
          label="Safety failures"
          value={String(safetyFailures)}
          sub={row ? `crisis checks held in ${row.safety.crisisPassed} of ${row.safety.crisisCases} crisis and look-alike cases` : undefined}
          tone={safetyFailures > 0 ? "bad" : "good"}
        />
        <Tile
          label="Judge mean, 1 to 5"
          value={score(weighted(latest, (s) => s.judgeMean))}
          sub={`helpful ${score(traits.helpful)}, accurate ${score(traits.accurate)}, plain ${score(traits.plain)}, warm ${score(traits.warm)}`}
        />
        <Tile label="Hard checks passed" value={pct1(weighted(latest, (s) => s.hardCheckPassRate))} sub="share of live answers that pass every check" />
        <Tile
          label="Time to first text"
          value={row ? secs(row.latency.firstTextP50Ms) : "n/a"}
          sub={row ? `median; slowest 5% at ${secs(row.latency.firstTextP95Ms)}, full answer median ${secs(row.latency.p50Ms)}` : undefined}
        />
        <Tile
          label="Persona probes"
          value={probes?.live ? `${probes.passed} of ${probes.total}` : "Not run"}
          sub={probes?.live ? `${probes.slowOnly ?? 0} failed only the 5 s first-text limit; crisis safe ${probes.crisisPassed} of ${probes.crisisTotal}; guard changed ${pct(probes.guardChangeRate)}` : probes?.detail}
          tone={probes?.live ? (probes.passed === probes.total ? "good" : undefined) : undefined}
        />
        <Tile
          label="Guardian"
          value={guardian?.ran ? `${guardian.precision.toFixed(2)} / ${guardian.recall.toFixed(2)}` : "Not run"}
          sub={guardian?.ran ? `precision / recall on ${guardian.cases} actions, median check ${secs(guardian.p50Ms)}` : guardian?.detail}
        />
        <Tile
          label="Mail deadlines right"
          value={mail ? pct(mail.accuracy) : "Not run"}
          sub={mail ? (mail.live ? `${mail.correct} of ${mail.letters} letters` : `stand-in: the mail reader is not merged yet`) : undefined}
        />
        <Tile
          label="Cost per 1,000 answers"
          value={latest.prices.configured ? `$${weighted(latest, (s) => s.usdPer1kAnswers).toFixed(2)}` : "Rates unset"}
          sub={`about ${Math.round(tokensPerAnswer).toLocaleString()} tokens per answer`}
        />
      </div>

      <section className={styles.section} style={{ padding: 0 }}>
        <h2>By suite</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Suite</th>
                <th>Live cases</th>
                <th>Hard checks</th>
                <th>Judge</th>
                <th>Helpful</th>
                <th>Accurate</th>
                <th>Plain</th>
                <th>Warm</th>
                <th>Safety</th>
                <th>First text p50 / p95</th>
                <th>Guard changed</th>
                <th>Per 1k</th>
              </tr>
            </thead>
            <tbody>
              {Object.values(latest.suites).map((s) => (
                <tr key={s.suite}>
                  <td>{SUITE_NAMES[s.suite] ?? s.suite} <span className="note">v{s.version}</span></td>
                  <td>{s.liveCases ?? 0} of {s.cases}</td>
                  <td>{pct1(s.hardCheckPassRate)}</td>
                  <td>{score(s.judgeMean)}</td>
                  <td>{s.traits ? score(s.traits.helpful) : "n/a"}</td>
                  <td>{s.traits ? score(s.traits.accurate) : "n/a"}</td>
                  <td>{s.traits ? score(s.traits.plain) : "n/a"}</td>
                  <td>{s.traits ? score(s.traits.warm) : "n/a"}</td>
                  <td style={{ color: s.gateFailed ? "var(--alert)" : undefined }}>{s.gateFailed ? `${s.gateFailures.length} failed` : "held"}</td>
                  <td>{s.firstTextP50Ms !== undefined ? `${secs(s.firstTextP50Ms)} / ${secs(s.firstTextP95Ms ?? 0)}` : "n/a"}</td>
                  <td>{s.guardChangeRate !== undefined ? pct(s.guardChangeRate) : "n/a"}</td>
                  <td>{latest.prices.configured ? `$${s.usdPer1kAnswers.toFixed(2)}` : "unset"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.section} style={{ padding: 0 }}>
        <h2>Trends</h2>
        <p>{history.length} nightly run(s). Only answers from live code are plotted.</p>
        <div className={styles.charts}>
          <Chart title="Hard checks passed" now={`latest ${pct1(weighted(latest, (s) => s.hardCheckPassRate))}`} labels={labels} min={0} max={1} format={pct} series={trendSeries(history, liveNames, (s) => s.hardCheckPassRate)} />
          <Chart title="Judge mean" now={`latest ${score(weighted(latest, (s) => s.judgeMean))}`} labels={labels} min={1} max={5} format={(n) => n.toFixed(0)} series={trendSeries(history, liveNames, (s) => s.judgeMean)} />
          <Chart
            title="Judge traits, all live answers"
            now={`helpful ${score(traits.helpful)}, accurate ${score(traits.accurate)}, plain ${score(traits.plain)}, warm ${score(traits.warm)}`}
            labels={labels} min={1} max={5} format={(n) => n.toFixed(0)}
            series={(["helpful", "accurate", "plain", "warm"] as const).map((t) => ({
              name: t,
              values: history.map((h) => {
                const rows = Object.values(h.suites).filter((s) => s.liveCases > 0 && s.traits);
                const n = rows.reduce((sum, s) => sum + s.liveCases, 0);
                return n === 0 ? null : rows.reduce((sum, s) => sum + s.traits![t] * s.liveCases, 0) / n;
              }),
            }))}
          />
          <Chart title="Safety failures" now={`latest ${safetyFailures}`} labels={labels} min={0} format={(n) => n.toFixed(0)} series={[{ name: "failures", values: history.map((h) => h.safety.failures) }]} />
          <Chart
            title="Time to first text"
            now={row ? `median ${secs(row.latency.firstTextP50Ms)}, p95 ${secs(row.latency.firstTextP95Ms)}` : ""}
            labels={labels} min={0} format={(n) => `${(n / 1000).toFixed(0)}s`}
            series={[
              { name: "median", values: history.map((h) => h.latency.firstTextP50Ms) },
              { name: "p95", values: history.map((h) => h.latency.firstTextP95Ms) },
            ]}
          />
          <Chart
            title="Persona probes"
            now={probes?.live ? `${probes.passed} of ${probes.total} passed, guard changed ${pct(probes.guardChangeRate)}` : "not run"}
            labels={labels} min={0} max={1} format={pct}
            series={[
              { name: "passed", values: history.map((h) => (h.probes?.live ? h.probes.passRate : null)) },
              { name: "guard changed", values: history.map((h) => (h.probes?.live ? h.probes.guardChangeRate : null)) },
            ]}
          />
          <Chart
            title="Guardian"
            now={guardian?.ran ? `precision ${guardian.precision.toFixed(3)}, recall ${guardian.recall.toFixed(3)}` : "not run"}
            labels={labels} min={0} max={1} format={(n) => n.toFixed(1)}
            series={[
              { name: "precision", values: history.map((h) => (h.guardian?.ran ? h.guardian.precision : null)) },
              { name: "recall", values: history.map((h) => (h.guardian?.ran ? h.guardian.recall : null)) },
            ]}
          />
          <Chart
            title={mail?.live ? "Mail deadlines right" : "Mail deadlines right (stand-in)"}
            now={mail ? `${mail.correct} of ${mail.letters}${mail.live ? "" : ", stand-in reader"}` : "not run"}
            labels={labels} min={0} max={1} format={pct}
            series={[{ name: "accuracy", values: history.map((h) => h.mail?.accuracy ?? null) }]}
          />
          {history.some((h) => h.usdPer1kAnswers !== null) ? (
            <Chart title="Cost per 1,000 answers" now={latest.prices.configured ? `$${weighted(latest, (s) => s.usdPer1kAnswers).toFixed(2)}` : "rates unset"} labels={labels} min={0} format={(n) => `$${n.toFixed(0)}`} series={[{ name: "cost", values: history.map((h) => h.usdPer1kAnswers) }]} />
          ) : null}
        </div>
        <div style={{ marginTop: 12 }}>
          <CostQuality latest={latest} />
        </div>
      </section>

      <section className={styles.section} style={{ padding: 0 }}>
        <h2>Lowest-scored answers</h2>
        <p>The live answers the judge scored lowest in this run, exactly as they would be sent.</p>
        {!casesConnected ? (
          <p className={styles.empty}>Per-case results are not connected.</p>
        ) : lowest.length === 0 ? (
          <p className={styles.empty}>No judged live answers in this run.</p>
        ) : (
          <div className={styles.cases}>
            {lowest.map((c) => (
              <div key={c.caseId} className={styles.case}>
                <div className={styles.head}>
                  <span className={styles.id}>{c.caseId}</span>
                  <span className={styles.meta}>
                    judge {score(c.judge!.mean)} (helpful {c.judge!.helpful}, accurate {c.judge!.accurate}, plain {c.judge!.plain}, warm {c.judge!.warm})
                  </span>
                </div>
                <p className={styles.reason}>{c.judge!.reason}</p>
                <Bubbles c={c} />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={styles.section} style={{ padding: 0 }}>
        <h2>Failed checks</h2>
        <p>{casesConnected ? `${failed.length} live answer(s) failed at least one hard check.` : ""}</p>
        {!casesConnected ? (
          <p className={styles.empty}>Per-case results are not connected.</p>
        ) : failed.length === 0 ? (
          <p className={styles.empty}>Every live answer passed every hard check.</p>
        ) : (
          <FailedList cases={failed} />
        )}
      </section>

      <section className={styles.section} style={{ padding: 0 }}>
        <h2>What did not run live</h2>
        {standins.length === 0 ? <p className={styles.empty}>Everything ran live.</p> : (
          <ul className={styles.labels}>
            {standins.map((s) => <li key={s}>{s}</li>)}
          </ul>
        )}
        <p className={styles.empty}>
          {latest.models?.answering?.endsWith("-contributor")
            ? "Synthetic answers run on the lower-cost synthetic tier; live texts run on the standard tier, so live replies are usually faster than the times above."
            : null}
          {suites.length > live.length ? ` Suites on a stand-in: ${suites.filter((s) => !liveNames.includes(s)).map((s) => SUITE_NAMES[s] ?? s).join(", ")}.` : ""}
        </p>
      </section>
    </Shell>
  );
}

function FailedList({ cases }: { cases: StaffCaseRow[] }) {
  const item = (c: StaffCaseRow) => (
    <div key={c.caseId} className={styles.case}>
      <div className={styles.head}>
        <span className={styles.id}>{c.caseId}</span>
        {c.judge ? <span className={styles.meta}>judge {score(c.judge.mean)}</span> : null}
      </div>
      <ul className={styles.fails}>
        {c.failed.map((f, i) => (
          <li key={i}><b>{f.id}</b> {f.detail}</li>
        ))}
      </ul>
      <Bubbles c={c} />
    </div>
  );
  return (
    <div className={styles.cases}>
      {cases.slice(0, 10).map(item)}
      {cases.length > 10 ? (
        <details className={styles.more}>
          <summary>{cases.length - 10} more</summary>
          <div className={styles.cases}>{cases.slice(10).map(item)}</div>
        </details>
      ) : null}
    </div>
  );
}
