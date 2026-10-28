import type { Household, StoredFile, Submission } from "./store";

export const TEST_BANNER = "TEST SYSTEM: this is a fake benefits portal for demos. No real benefits. No real data.";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const OLD_STYLE = `
  body { background: #c0c0c0; color: #000; font-family: Verdana, Arial, sans-serif; font-size: 12px; margin: 0; }
  .banner { background: #cc0000; color: #fff; font-weight: bold; font-size: 13px; text-align: center; padding: 6px; }
  .wrap { width: 760px; margin: 12px auto; background: #fff; border: 2px solid #003366; }
  .masthead { background: #003366; color: #fff; padding: 10px 14px; }
  .masthead h1 { font-size: 18px; margin: 0; }
  .masthead p { font-size: 11px; margin: 2px 0 0 0; }
  .body { padding: 14px; }
  table.form { border-collapse: collapse; width: 100%; }
  table.form td { border: 1px solid #999; padding: 5px 7px; font-size: 12px; vertical-align: top; }
  table.form td.label { background: #e8e8e8; width: 220px; font-weight: bold; }
  input[type=text], input[type=tel], input[type=date] { width: 280px; font-size: 12px; border: 1px solid #666; padding: 2px; }
  .btn { background: #003366; color: #fff; border: 2px outset #6699cc; font-size: 13px; font-weight: bold; padding: 4px 18px; cursor: pointer; }
  .error { background: #ffdddd; border: 1px solid #cc0000; padding: 8px; margin: 0 0 10px 0; font-size: 12px; }
  .notice { background: #ffffcc; border: 1px solid #999900; padding: 8px; margin: 0 0 10px 0; font-size: 12px; }
  .steps { font-size: 11px; color: #333; margin: 0 0 10px 0; }
  .steps b { color: #003366; }
  .footer { border-top: 1px solid #999; padding: 8px 14px; font-size: 10px; color: #333; background: #e8e8e8; }
  .conf { font-size: 22px; font-weight: bold; color: #003366; letter-spacing: 1px; }
  .key { font-family: monospace; font-size: 11px; word-break: break-all; }
  a { color: #003399; }
`;

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)} - State Benefits Renewal</title>
<style>${OLD_STYLE}</style></head>
<body>
<div class="banner">${escapeHtml(TEST_BANNER)}</div>
<div class="wrap">
<div class="masthead"><h1>State Benefits Renewal Office</h1><p>Online renewal application. Best viewed at 800x600.</p></div>
<div class="body">
${body}
</div>
<div class="footer">State Benefits Renewal Office. This is a test system for software demonstrations. Do not enter real personal information.</div>
</div>
</body>
</html>`;
}

export function homePage(): string {
  return layout(
    "Welcome",
    `<div class="notice"><b>Notice:</b> This demonstration portal accepts renewal applications from test residents only. It is not connected to any real benefits system.</div>
<table class="form">
<tr><td class="label">Renew your benefits</td><td>File your yearly renewal online in three steps: household information, supporting documents, review and submit. You will receive a confirmation number.</td></tr>
<tr><td class="label">Caseworkers</td><td><a href="/caseworker">View submitted applications</a> (staff test view).</td></tr>
</table>
<p><a class="btn" style="text-decoration:none; display:inline-block; margin-top:10px;" href="/apply">Start renewal application</a></p>`,
  );
}

export function householdPage(error?: string, previous?: Partial<Household>): string {
  const v = (name: keyof Household): string => escapeHtml(previous?.[name] ?? "");
  const err = error ? `<div class="error"><b>Error:</b> ${escapeHtml(error)}</div>` : "";
  return layout(
    "Step 1 of 3: Household",
    `<div class="steps"><b>Step 1: Household</b> &gt; Step 2: Documents &gt; Step 3: Review</div>
${err}
<form method="post" action="/apply/household">
<table class="form">
<tr><td class="label">Full legal name</td><td><input type="text" name="fullName" value="${v("fullName")}"></td></tr>
<tr><td class="label">Date of birth</td><td><input type="date" name="dateOfBirth" value="${v("dateOfBirth")}"></td></tr>
<tr><td class="label">Mailing address</td><td><input type="text" name="address" value="${v("address")}"></td></tr>
<tr><td class="label">Phone number</td><td><input type="tel" name="phone" value="${v("phone")}"></td></tr>
<tr><td class="label">People in household</td><td><input type="text" name="householdSize" value="${v("householdSize")}"></td></tr>
<tr><td class="label">Monthly income ($)</td><td><input type="text" name="monthlyIncome" value="${v("monthlyIncome")}"></td></tr>
</table>
<p><button class="btn" type="submit">Continue to Step 2</button></p>
</form>`,
  );
}

export function documentsPage(error?: string): string {
  const err = error ? `<div class="error"><b>Error:</b> ${escapeHtml(error)}</div>` : "";
  return layout(
    "Step 2 of 3: Documents",
    `<div class="steps">Step 1: Household &gt; <b>Step 2: Documents</b> &gt; Step 3: Review</div>
${err}
<div class="notice"><b>Required:</b> attach a pay stub or proof of income (PDF, PNG or JPG, each under the posted size limit). Test files only.</div>
<form method="post" action="/apply/documents" enctype="multipart/form-data">
<table class="form">
<tr><td class="label">Document 1</td><td><input type="file" name="document1"></td></tr>
<tr><td class="label">Document 2 (optional)</td><td><input type="file" name="document2"></td></tr>
<tr><td class="label">Document 3 (optional)</td><td><input type="file" name="document3"></td></tr>
</table>
<p><button class="btn" type="submit">Continue to Step 3</button></p>
</form>`,
  );
}

export function reviewPage(household: Household, files: StoredFile[], key: string, digest: string): string {
  const rows = files
    .map((f) => `<tr><td class="label">Attached file</td><td>${escapeHtml(f.name)} (${escapeHtml(f.type)}, ${f.size} bytes)</td></tr>`)
    .join("");
  return layout(
    "Step 3 of 3: Review",
    `<div class="steps">Step 1: Household &gt; Step 2: Documents &gt; <b>Step 3: Review</b></div>
<div class="notice"><b>Check every field.</b> Pressing Submit sends this exact application. Your submission key is <span class="key">${escapeHtml(key)}</span>. If the page times out, Mano checks this key instead of submitting twice.</div>
<table class="form">
<tr><td class="label">Full legal name</td><td>${escapeHtml(household.fullName)}</td></tr>
<tr><td class="label">Date of birth</td><td>${escapeHtml(household.dateOfBirth)}</td></tr>
<tr><td class="label">Mailing address</td><td>${escapeHtml(household.address)}</td></tr>
<tr><td class="label">Phone number</td><td>${escapeHtml(household.phone)}</td></tr>
<tr><td class="label">People in household</td><td>${escapeHtml(household.householdSize)}</td></tr>
<tr><td class="label">Monthly income ($)</td><td>${escapeHtml(household.monthlyIncome)}</td></tr>
${rows}
</table>
<form method="post" action="/submissions">
<input type="hidden" name="key" value="${escapeHtml(key)}">
<input type="hidden" name="digest" value="${escapeHtml(digest)}">
<table class="form" style="margin-top:10px;">
<tr><td class="label">Slow mode (demo)</td><td><label><input type="checkbox" name="slow" value="1"> Hold the response past the caller's timeout (the office still receives it)</label></td></tr>
</table>
<p><button class="btn" type="submit">Submit application</button></p>
</form>`,
  );
}

export function confirmationPage(sub: Submission, duplicate: boolean): string {
  const dup = duplicate
    ? `<div class="notice"><b>Already received:</b> this submission key arrived before. No second application was filed. Your original confirmation number is below.</div>`
    : "";
  const slow =
    sub.slowMs > 0
      ? `<div class="notice"><b>Slow mode:</b> the office held this response for ${(sub.slowMs / 1000).toFixed(0)} seconds after receiving your application.</div>`
      : "";
  return layout(
    "Confirmation",
    `${dup}${slow}
<table class="form">
<tr><td class="label">Confirmation number</td><td><span class="conf">${escapeHtml(sub.confirmationNumber)}</span></td></tr>
<tr><td class="label">Applicant</td><td>${escapeHtml(sub.household.fullName)}</td></tr>
<tr><td class="label">Received</td><td>${escapeHtml(new Date(sub.receivedAt).toUTCString())}</td></tr>
<tr><td class="label">Submission key</td><td><span class="key">${escapeHtml(sub.key)}</span></td></tr>
</table>
<p>Write down your confirmation number. A caseworker will review your renewal.</p>
<p><a href="/">Return to the home page</a></p>`,
  );
}

export function timeoutPage(): string {
  return layout(
    "Session timed out",
    `<div class="error"><b>Your session timed out.</b> For your protection this office signs you out after a period without activity. Nothing was submitted.</div>
<p><a class="btn" style="text-decoration:none; display:inline-block;" href="/apply">Start a new application</a></p>`,
  );
}

export function errorPage(title: string, message: string, backHref: string, backLabel: string): string {
  return layout(
    title,
    `<div class="error"><b>Error:</b> ${escapeHtml(message)}</div>
<p><a href="${escapeHtml(backHref)}">${escapeHtml(backLabel)}</a></p>`,
  );
}

export function caseworkerListPage(subs: Submission[]): string {
  const rows =
    subs.length === 0
      ? `<tr><td colspan="4">No applications received yet.</td></tr>`
      : subs
          .map(
            (s) => `<tr><td><a href="/caseworker/${escapeHtml(s.confirmationNumber)}">${escapeHtml(s.confirmationNumber)}</a></td>
<td>${escapeHtml(s.household.fullName)}</td>
<td>${escapeHtml(new Date(s.receivedAt).toUTCString())}</td>
<td>${s.files.length} file(s)</td></tr>`,
          )
          .join("");
  return layout(
    "Caseworker view",
    `<div class="notice"><b>Staff test view.</b> Applications submitted through the renewal portal appear below, newest first.</div>
<table class="form">
<tr><td class="label">Confirmation</td><td class="label">Applicant</td><td class="label">Received</td><td class="label">Files</td></tr>
${rows}
</table>
<p><a href="/">Back to the home page</a></p>`,
  );
}

export function caseworkerDetailPage(sub: Submission): string {
  const files = sub.files
    .map(
      (f, i) =>
        `<tr><td class="label">File ${i + 1}</td><td><a href="/caseworker/${escapeHtml(sub.confirmationNumber)}/file/${i}">${escapeHtml(f.name)}</a> (${escapeHtml(f.type)}, ${f.size} bytes)</td></tr>`,
    )
    .join("");
  return layout(
    `Case ${sub.confirmationNumber}`,
    `<table class="form">
<tr><td class="label">Confirmation</td><td><span class="conf">${escapeHtml(sub.confirmationNumber)}</span></td></tr>
<tr><td class="label">Applicant</td><td>${escapeHtml(sub.household.fullName)}</td></tr>
<tr><td class="label">Date of birth</td><td>${escapeHtml(sub.household.dateOfBirth)}</td></tr>
<tr><td class="label">Address</td><td>${escapeHtml(sub.household.address)}</td></tr>
<tr><td class="label">Phone</td><td>${escapeHtml(sub.household.phone)}</td></tr>
<tr><td class="label">Household size</td><td>${escapeHtml(sub.household.householdSize)}</td></tr>
<tr><td class="label">Monthly income</td><td>$${escapeHtml(sub.household.monthlyIncome)}</td></tr>
<tr><td class="label">Received</td><td>${escapeHtml(new Date(sub.receivedAt).toUTCString())} via ${escapeHtml(sub.source)}</td></tr>
<tr><td class="label">Submission key</td><td><span class="key">${escapeHtml(sub.key)}</span></td></tr>
${files}
</table>
<p><a href="/caseworker">Back to the list</a></p>`,
  );
}
