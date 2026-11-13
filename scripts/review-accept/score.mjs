// Failure-mode scoring for VD-R-JUDGE. Pure: callers supply the validated
// verdicts per golden case and an evidence checker that resolves the original
// message/outbox row. Real model runs are D-10b; this file only scores them.
const familyOf = (failureType) => (failureType ? failureType.split(".").slice(0, 2).join(".") : null);

function matchesFamily(expect, actual) {
  if (!expect) return true;
  if (expect.endsWith(".*")) return String(actual || "").startsWith(expect.slice(0, -1));
  return actual === expect;
}

function textOf(verdict) {
  return [verdict.reasoning, verdict.what_happened, verdict.expected, verdict.root_cause, verdict.next_attempt_plan, verdict.reason]
    .filter(Boolean).join("\n").toLowerCase();
}

export function scoreJudgeResults({ golden, negatives = [], byCase, controls = [], evidenceCheck = () => true }) {
  const rows = [];
  let denominator = 0, hits = 0, evidenceTotal = 0, evidenceOk = 0;
  const disputed = [];
  for (const item of golden) {
    const verdicts = byCase.get(item.case) || [];
    const evidence = verdicts.flatMap((verdict) => verdict.evidence || []);
    for (const ev of evidence) {
      evidenceTotal++;
      if (evidenceCheck(ev)) evidenceOk++;
    }
    if (item.disputed_label) {
      disputed.push({ case: item.case, verdicts: verdicts.length, reason: "disputed_label" });
      continue;
    }
    denominator++;
    const matched = verdicts.find((verdict) => {
      if (!matchesFamily(item.expect_family, verdict.failure_type)) return false;
      if (item.expect_gap_type && verdict.gap_type !== item.expect_gap_type) return false;
      const text = textOf(verdict);
      return (item.expect_root_cause_keys || []).some((key) => text.includes(String(key).toLowerCase()));
    });
    if (matched) hits++;
    rows.push({ case: item.case, hit: Boolean(matched), failure_type: verdicts[0]?.failure_type || null, gap_type: verdicts[0]?.gap_type || null });
  }
  const controlFalse = controls.filter((verdict) => verdict.kind && verdict.kind !== "none" && ["p0", "p1"].includes(verdict.severity)).length;
  const negativeFalse = negatives.filter((negative) => {
    const verdicts = byCase.get(negative.case) || [];
    return verdicts.some((verdict) => verdict.kind !== "none" && ["p0", "p1"].includes(verdict.severity));
  }).length;
  return {
    denominator,
    hits,
    accuracy: denominator ? hits / denominator : 0,
    disputed,
    rows,
    controls: controls.length,
    falsePositives: controlFalse + negativeFalse,
    evidenceTotal,
    evidenceOk,
    evidenceRate: evidenceTotal ? evidenceOk / evidenceTotal : 1,
  };
}

export function assertJudgeReport(report, { accuracy = 0.75 } = {}) {
  const failures = [];
  if (report.accuracy < accuracy) failures.push(`accuracy ${report.accuracy.toFixed(3)} < ${accuracy}`);
  if (report.falsePositives !== 0) failures.push(`false positives ${report.falsePositives}`);
  if (report.evidenceRate !== 1) failures.push(`evidence ${report.evidenceOk}/${report.evidenceTotal}`);
  return { ok: failures.length === 0, failures };
}
