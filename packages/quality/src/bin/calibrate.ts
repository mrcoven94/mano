// calibrate: score the 30 hand-labeled cases and report judge agreement.
// Exits 1 when agreement is under 80%. Usage: node src/bin/calibrate.ts

import { agreement, buildCalibrationSet, CALIBRATION_LABELS_PROVISIONAL } from "../calibration.ts";
import { judgeClientFromEnv } from "../models.ts";
import { FakeJudge, JUDGE_AGREEMENT_MIN, MetaJudge, judgeAll } from "../judge.ts";

const cal = buildCalibrationSet();
console.log(`calibration: ${cal.length} cases, labels ${CALIBRATION_LABELS_PROVISIONAL ? "provisional (architect replaces)" : "hand-labeled"}`);
const model = judgeClientFromEnv(process.env);
const judge = model.live ? new MetaJudge(model) : new FakeJudge();
const scores = await judgeAll(cal.map((c) => ({ answer: c.answer, facts: c.facts, reference: c.reference })), judge, 99);
const rate = agreement(scores, cal.map((c) => c.label));
console.log(`judge ${judge.id}: agreement ${Math.round(rate * 100)}% (needs ${JUDGE_AGREEMENT_MIN * 100}%)`);
scores.forEach((s, i) => {
  if (s.pass !== cal[i]!.label) console.log(`  miss ${cal[i]!.caseId}: judge=${s.pass} label=${cal[i]!.label} (${cal[i]!.why})`);
});
if (rate < JUDGE_AGREEMENT_MIN) {
  console.error("judge rejected: agreement under 80%");
  process.exitCode = 1;
}
