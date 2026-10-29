import type { Metadata } from "next";
import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { countersTotal, judgeMeanOf, loadQuality } from "@/lib/quality";
import TokenForm from "./TokenForm";

export const metadata: Metadata = {
  title: "Quality",
  description: "Staff view of Mano answer quality: nightly bench scores, trends, and live counters.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const cell: React.CSSProperties = { textAlign: "left", padding: "6px 12px 6px 0", verticalAlign: "top" };

function signedIn(stored: string | undefined): boolean {
  const expected = process.env.QUALITY_STAFF_TOKEN ?? "";
  if (!expected || !stored) return false;
  const x = Buffer.from(stored);
  const y = Buffer.from(expected);
  return x.length === y.length && timingSafeEqual(x, y);
}

export default async function QualityPage() {
  const jar = await cookies();
  if (!signedIn(jar.get("mano_staff")?.value)) {
    return (
      <div className="wrap" style={{ paddingTop: 48, paddingBottom: 64 }}>
        <h1>Quality</h1>
        {process.env.QUALITY_STAFF_TOKEN ? (
          <TokenForm />
        ) : (
          <p>Staff sign-in for this page is not configured yet.</p>
        )}
      </div>
    );
  }

  const base = (process.env.QUALITY_RUNS_URL ?? "").replace(/\/$/, "");
  if (!base) {
    return (
      <div className="wrap" style={{ paddingTop: 48, paddingBottom: 64 }}>
        <h1>Quality</h1>
        <p>No nightly runs yet. The first scheduled run publishes here.</p>
      </div>
    );
  }

  const { latest, history, lowest, failed, casesConnected, counters } = await loadQuality(base);
  if (!latest) {
    return (
      <div className="wrap" style={{ paddingTop: 48, paddingBottom: 64 }}>
        <h1>Quality</h1>
        <p>The runs store did not answer. Check back after the next nightly run.</p>
      </div>
    );
  }

  const standins = Object.entries(latest.paths).filter(([, p]) => !p.live).map(([s]) => s);
  return (
    <div className="wrap" style={{ paddingTop: 48, paddingBottom: 64 }}>
      <h1>Quality</h1>
      <p>
        Nightly run {latest.runId} ({latest.caseCount} synthetic cases, {new Date(latest.startedAt).toLocaleDateString()}).
        Gate {latest.gateFailed ? "failed" : "passed"}.
        Judge {latest.judge.live ? "live" : "stand-in"}, agreement {Math.round(latest.calibration.agreement * 100)}%
        {latest.calibration.provisional ? " on provisional labels" : ""}.
        Holdout {latest.holdout.configured ? "ran" : "not configured"}.
        {standins.length > 0 ? ` Stand-in paths: ${standins.join(", ")}.` : " All suites ran on live code paths."}
      </p>

      <h2>Latest nightly run per suite</h2>
      <table>
        <thead>
          <tr>
            <th style={cell}>Suite</th>
            <th style={cell}>Hard pass</th>
            <th style={cell}>Judge mean</th>
            <th style={cell}>Gate</th>
            <th style={cell}>p50 / p95</th>
            <th style={cell}>Cost per 1k</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(latest.suites).map(([name, s]) => (
            <tr key={name}>
              <td style={cell}>{name} (v{s.version}, {s.cases} cases)</td>
              <td style={cell}>{(s.hardCheckPassRate * 100).toFixed(1)}%</td>
              <td style={cell}>{s.judgeMean.toFixed(2)}</td>
              <td style={cell}>{s.gateFailed ? "Failed" : "Passed"}</td>
              <td style={cell}>{s.p50Ms} / {s.p95Ms} ms</td>
              <td style={cell}>{latest.prices.configured ? `$${s.usdPer1kAnswers.toFixed(2)}` : "Rates unset"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Trends</h2>
      {history.length === 0 ? (
        <p>One run so far; trends appear after the second nightly run.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={cell}>Run</th>
              {Object.keys(latest.suites).map((name) => (
                <th key={name} style={cell}>{name} hard / judge</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.runId}>
                <td style={cell}>{h.runId}</td>
                {Object.keys(latest.suites).map((name) => {
                  const s = h.suites[name];
                  return <td key={name} style={cell}>{s ? `${(s.hardCheckPassRate * 100).toFixed(1)}% / ${s.judgeMean.toFixed(2)}` : "—"}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Lowest judged synthetic answers</h2>
      {!casesConnected ? (
        <p>Per-case detail is not connected yet.</p>
      ) : lowest.length === 0 ? (
        <p>No judged answers in this run.</p>
      ) : (
        <ol>
          {lowest.map((c) => (
            <li key={c.caseId} style={{ marginBottom: 16 }}>
              <p><b>{c.caseId}</b> ({c.suite}), judge mean {judgeMeanOf(c.judge)?.toFixed(2)}. {c.judge?.reason}</p>
              <blockquote style={{ margin: "8px 0" }}>{c.answer.text}</blockquote>
            </li>
          ))}
        </ol>
      )}

      <h2>Failed hard checks</h2>
      {!casesConnected ? (
        <p>Per-case detail is not connected yet.</p>
      ) : failed.length === 0 ? (
        <p>Every synthetic case passed every hard check.</p>
      ) : (
        <ol>
          {failed.map((c) => (
            <li key={c.caseId} style={{ marginBottom: 16 }}>
              <p><b>{c.caseId}</b> ({c.suite})</p>
              <ul>
                {c.checks.filter((r) => !r.pass).map((r) => (
                  <li key={r.id}>{r.id}: {r.detail}</li>
                ))}
              </ul>
              <blockquote style={{ margin: "8px 0" }}>{c.answer.text}</blockquote>
            </li>
          ))}
        </ol>
      )}

      <h2>Live counters</h2>
      {counters ? (
        <div>
          <p>Week {counters.week}. Counts under 10 are hidden{counters.hiddenCells > 0 ? `, including ${counters.hiddenCells} hidden cell(s)` : ""}.</p>
          <table>
            <thead>
              <tr>
                <th style={cell}>Kind</th>
                <th style={cell}>Conversations</th>
              </tr>
            </thead>
            <tbody>
              {counters.counters.map((c) => (
                <tr key={c.label}>
                  <td style={cell}>{c.label}</td>
                  <td style={cell}>{c.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>Total: {countersTotal(counters) === null ? "hidden" : countersTotal(counters)}.</p>
        </div>
      ) : (
        <p>Live counters are not connected yet. The engine publishes counts once the live hooks are wired.</p>
      )}
    </div>
  );
}
