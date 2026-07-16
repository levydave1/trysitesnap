import { generateEmailForLead, leadFromEmailRecord, normalizeEmailFlow } from "./email-export.js";

function recordId(value) {
  const normalized = String(value || "").trim();
  if (!/^rec[a-zA-Z0-9]{14}$/.test(normalized)) throw new Error("Invalid Airtable record ID");
  return normalized;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function testEmailHtml(lead, email, index, total) {
  return `<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#111">
  <div style="background:#fff4cc;border:1px solid #e4c34d;padding:14px 16px;margin-bottom:24px">
    <strong>SiteSnap V2 test ${index + 1}/${total}</strong><br>
    Generated for ${escapeHtml(lead.businessName)}. This test was redirected to the approved test inbox and was not sent to the lead.
  </div>
  <div style="font-size:14px;color:#666;margin-bottom:8px">Subject: ${escapeHtml(email.subject)}</div>
  <div style="white-space:pre-wrap;font-size:16px;line-height:1.55">${escapeHtml(email.body)}</div>
  </div>`;
}

export async function sendEmailPreviewTests(dependencies, options = {}) {
  const ids = [...new Set((options.recordIds || []).map(recordId))];
  if (ids.length !== 3) throw new Error("Exactly three unique record IDs are required");
  if (!dependencies.mail) throw new Error("Mail relay is not configured");

  const flow = normalizeEmailFlow(options.flow);
  const results = [];
  for (let index = 0; index < ids.length; index += 1) {
    const record = await dependencies.airtable.getRecordFromTable(
      dependencies.config.airtable.rawOutscraperTableId,
      ids[index]
    );
    const lead = leadFromEmailRecord(record);
    const email = await generateEmailForLead(dependencies, lead, flow);
    await dependencies.mail.send({
      to: dependencies.config.emailExport.testRecipient,
      subject: `[SiteSnap V2 Test ${index + 1}/3] ${email.subject}`,
      html: testEmailHtml(lead, email, index, ids.length)
    });
    results.push({ recordId: ids[index], businessName: lead.businessName, subject: email.subject, body: email.body });
  }

  return {
    success: true,
    flow,
    recipient: dependencies.config.emailExport.testRecipient,
    sent: results.length,
    results
  };
}
