import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  generateHouseholds,
  generateDevHouseholds,
  generateHeldoutHouseholds,
  splitHouseholds,
  STATES,
  DEV_SEED,
} from "../src/generator.mjs";
import { toBaselineInput, toBaselineInputs, toAnswers, assertNoForbiddenFields, guardInput, FORBIDDEN_FIELDS } from "../src/inputs.mjs";
import { reminderBaseline, generalAgentBaseline, GENERAL_AGENT_MODEL } from "../src/baselines.mjs";
import { gradeAll } from "../src/grader.mjs";
import { checkLinkOffline } from "../src/tools.mjs";
import { contentHash, renderPhotoSvg } from "../src/render.mjs";

test("generator is deterministic and covers 120 households in 6 states", () => {
  const a = generateHouseholds("test-seed-1");
  const b = generateHouseholds("test-seed-1");
  assert.equal(contentHash(a), contentHash(b));
  assert.equal(a.length, 120);
  assert.deepEqual([...new Set(a.map((h) => h.state))].sort(), [...STATES].sort());
  for (const h of a) assert.ok(h.letters.length >= 3 && h.letters.length <= 8);
});

test("split is 20 dev and 100 held out with separate seeds", () => {
  const dev = generateDevHouseholds();
  assert.equal(dev.length, 20);
  const heldout = generateHeldoutHouseholds("test-heldout-seed");
  assert.equal(heldout.length, 100);
  const { dev: d2, heldout: h2 } = splitHouseholds(generateHouseholds("s"));
  assert.equal(d2.length, 20);
  assert.equal(h2.length, 100);
});

test("held-out generator requires the secret seed", () => {
  const saved = process.env.MANO_EVAL_HELDOUT_SEED;
  delete process.env.MANO_EVAL_HELDOUT_SEED;
  assert.throws(() => generateHeldoutHouseholds(), /MANO_EVAL_HELDOUT_SEED/);
  if (saved !== undefined) process.env.MANO_EVAL_HELDOUT_SEED = saved;
});

test("ground truth has deadlines, packet, refusals and requests", () => {
  const dev = generateDevHouseholds();
  for (const h of dev) {
    assert.ok(Array.isArray(h.groundTruth.deadlines));
    assert.ok(Array.isArray(h.groundTruth.correctPacket));
    assert.ok(Array.isArray(h.groundTruth.mustRefuse));
    assert.ok(Array.isArray(h.groundTruth.mustRequest));
  }
  const allRefusals = dev.flatMap((h) => h.groundTruth.mustRefuse);
  assert.ok(allRefusals.length > 0, "dev split must contain refusal cases");
});

test("hard cases are present in dev split", () => {
  const dev = generateDevHouseholds();
  const kinds = new Set(dev.flatMap((h) => h.letters.map((l) => l.hardCase).filter(Boolean)));
  for (const k of ["planted_instruction", "scam_link", "spanish", "conflicting_dates"]) {
    assert.ok(kinds.has(k), `missing hard case ${k}`);
  }
});

test("link checker blocks scam domains and fails closed on bad URLs", () => {
  assert.equal(checkLinkOffline("https://benefits-verify-now.example/claim").allowed, false);
  assert.equal(checkLinkOffline("not a url").allowed, false);
});

test("baseline inputs contain no answer-key fields", () => {
  const dev = generateDevHouseholds();
  const inputs = toBaselineInputs(dev);
  assertNoForbiddenFields(inputs);
  for (const input of inputs) {
    assert.deepEqual(Object.keys(input).sort(), ["householdId", "letters", "name", "state"]);
    for (const l of input.letters) {
      assert.deepEqual(Object.keys(l).sort(), ["letterId", "pages", "text"]);
    }
  }
});

test("committed dev.json contains no answer-key fields", async () => {
  const dev = JSON.parse(await readFile(new URL("../data/dev.json", import.meta.url), "utf8"));
  assertNoForbiddenFields(dev);
  const raw = await readFile(new URL("../data/dev.json", import.meta.url), "utf8");
  for (const f of ["groundTruth", "correctPacket", "mustRefuse", "mustRequest", "hardCase"]) {
    assert.ok(!raw.includes(`\"${f}\"`), `dev.json leaks ${f}`);
  }
});

test("baselines cannot reach the answer key even when it is adjacent", async () => {
  const dev = generateDevHouseholds();
  const answers = toAnswers(dev);
  for (const h of dev.slice(0, 5)) {
    // Full household with labels, guarded: any read of a forbidden field throws.
    const guarded = guardInput({ ...toBaselineInput(h), ...h });
    reminderBaseline(guarded);
    const saved = process.env.META_MODEL_API_KEY;
    delete process.env.META_MODEL_API_KEY;
    await generalAgentBaseline(guarded);
    if (saved !== undefined) process.env.META_MODEL_API_KEY = saved;
    assert.ok(answers[h.householdId], "grader alone loads answers");
  }
});

test("baseline source never names answer-key fields", async () => {
  const src = await readFile(new URL("../src/baselines.mjs", import.meta.url), "utf8");
  for (const f of ["groundTruth", "correctPacket", "mustRefuse", "mustRequest", "hardCase", ".kind"]) {
    assert.ok(!src.includes(f), `baselines.mjs mentions ${f}`);
  }
});

test("reminder baseline runs and grader scores it", () => {
  const dev = generateDevHouseholds();
  const inputs = toBaselineInputs(dev);
  const answers = toAnswers(dev);
  const graded = gradeAll(inputs.map(reminderBaseline), answers);
  assert.equal(graded.households, 20);
});

test("general agent returns not run without a key", async () => {
  const saved = process.env.META_MODEL_API_KEY;
  delete process.env.META_MODEL_API_KEY;
  const dev = generateDevHouseholds();
  const out = await generalAgentBaseline(toBaselineInput(dev[0]));
  assert.equal(out.status, "not run");
  assert.equal(out.model, GENERAL_AGENT_MODEL);
  assert.ok(typeof out.elapsedMs === "number");
  if (saved !== undefined) process.env.META_MODEL_API_KEY = saved;
});

test("general agent parses structured model output and records cost and time", async () => {
  const saved = process.env.META_MODEL_API_KEY;
  process.env.META_MODEL_API_KEY = "test-key";
  const dev = generateDevHouseholds();
  const input = toBaselineInput(dev[0]);
  const firstId = input.letters[0].letterId;
  const fetchImpl = async (url) => {
    if (String(url).includes("dns-query")) {
      return { ok: true, json: async () => ({ Answer: [{ data: "93.184.216.34" }] }) };
    }
    const body = JSON.stringify({
      reminders: [{ letterId: firstId, dueDate: "2026-11-20" }],
      packet: ["signed renewal form"],
      refused: [],
      requested: ["pay stub"],
      failures: [],
    });
    return {
      ok: true,
      json: async () => ({
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: body }] }],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      }),
    };
  };
  const out = await generalAgentBaseline(input, { fetchImpl });
  assert.equal(out.status, "ok");
  assert.equal(out.model, GENERAL_AGENT_MODEL);
  assert.equal(out.reminders[0].letterId, firstId);
  assert.deepEqual(out.packet, ["signed renewal form"]);
  assert.deepEqual(out.requested, ["pay stub"]);
  assert.ok(typeof out.elapsedMs === "number");
  assert.ok(typeof out.costUsd === "number");
  assert.equal(out.promptTokens, 100);
  assert.equal(out.completionTokens, 50);
  if (saved === undefined) delete process.env.META_MODEL_API_KEY;
  else process.env.META_MODEL_API_KEY = saved;
});

test("letters are full pages with letterhead, case number and written dates", () => {
  const dev = generateDevHouseholds();
  const writtenRe = /(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, 2026/;
  let writtenCount = 0;
  let isoInText = 0;
  for (const h of dev) {
    for (const l of h.letters) {
      if (l.kind === "decoy_ad") continue;
      if (l.hardCase !== "cutoff") {
        assert.ok(l.text.length > 400, `${l.letterId} too short (${l.text.length})`);
      }
      if (l.hardCase !== "unreadable") {
        assert.ok(/Case No\.|Account No\.|Caso nro\./.test(l.text), `${l.letterId} missing case number`);
      }
      if (l.lang !== "es" && l.hardCase !== "unreadable" && l.hardCase !== "cutoff") {
        assert.ok(writtenRe.test(l.text), `${l.letterId} missing written-out date`);
      }
      if (writtenRe.test(l.text)) writtenCount++;
      if (/\b20\d{2}-\d{2}-\d{2}\b/.test(l.text)) isoInText++;
    }
  }
  assert.ok(writtenCount > 40, `expected many written dates, got ${writtenCount}`);
  assert.equal(isoInText, 0, "letter text must not contain ISO dates");
});

test("agency matches the program", () => {
  const dev = generateDevHouseholds();
  for (const h of dev) {
    for (const l of h.letters) {
      if (l.lang === "es") continue;
      if (h.state === "CA" && l.kind === "snap_recert") {
        assert.ok(/CalFresh|Social Services/.test(l.text), `${l.letterId} CA SNAP must come from CalFresh/CDSS`);
        assert.ok(!/Health Care Services/.test(l.text), `${l.letterId} CA SNAP must not come from DHCS`);
      }
      if (h.state === "WA" && l.kind === "snap_recert") {
        assert.ok(/Basic Food|Social and Health Services/.test(l.text), `${l.letterId} WA SNAP must be Basic Food at DSHS`);
      }
      if (h.state === "WA" && l.kind === "medicaid_renewal") {
        assert.ok(/Apple Health|Health Care Authority/.test(l.text), `${l.letterId} WA Medicaid must be Apple Health at HCA`);
      }
      if (l.kind === "utility_shutoff") {
        assert.ok(!/Department of|Agency for/.test(l.text) || /Utility|Power|Energy|Water/.test(l.text), `${l.letterId} utility notice must come from a utility`);
      }
    }
  }
});

test("committed photos are real images, not SVG text", async () => {
  const files = await readdir(new URL("../data/photos", import.meta.url));
  const jpgs = files.filter((f) => f.endsWith(".jpg") || f.endsWith(".jpeg") || f.endsWith(".png"));
  const svgs = files.filter((f) => f.endsWith(".svg"));
  assert.equal(svgs.length, 0, "committed photos must not be SVG");
  assert.ok(jpgs.length >= 20, `expected at least 20 photo images, got ${jpgs.length}`);
  for (const f of jpgs.slice(0, 3)) {
    const buf = await readFile(new URL(`../data/photos/${f}`, import.meta.url));
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    assert.ok(isJpeg || isPng, `${f} is not a real image`);
    assert.ok(buf.length > 20000, `${f} suspiciously small (${buf.length} bytes)`);
  }
});

test("some letters have a second page", () => {
  const dev = generateDevHouseholds();
  const twoPage = dev.flatMap((h) => h.letters).filter((l) => l.pageCount === 2);
  assert.ok(twoPage.length > 5, "expected several two-page letters");
});

test("SVG remains only the render source", () => {
  const dev = generateDevHouseholds();
  const svg = renderPhotoSvg(dev[0].letters[0], dev[0].householdId);
  assert.ok(svg.startsWith("<svg"), "SVG source must exist for rendering");
});

test("FROZEN.md commits hashes only, never the seed", async () => {
  const md = await readFile(new URL("../FROZEN.md", import.meta.url), "utf8");
  assert.ok(!/^Seed: `/m.test(md), "FROZEN.md must not contain the public seed");
  assert.ok(/Seed commitment/.test(md), "FROZEN.md must carry the seed commitment");
  assert.ok(/Manifest SHA-256/.test(md), "FROZEN.md must carry the manifest hash");
  const seed = process.env.MANO_EVAL_HELDOUT_SEED;
  if (seed) assert.ok(!md.includes(seed), "FROZEN.md must never contain the seed value");
});
