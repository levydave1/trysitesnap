const trackerEndpoint = "https://trysitesnap.com/api/3b7f5316669d40c19e243c38f67b52ec";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function emailFrame({ eyebrow = "SiteSnap • Pure Simplicity", title, greeting, body, action }) {
  const actionHtml = action
    ? `<div style="text-align:center;margin:32px 0"><a href="${escapeHtml(action.href)}" style="display:inline-block;background:#0070f3;color:#fff;padding:16px 28px;border-radius:999px;text-decoration:none;font-weight:800">${escapeHtml(action.label)}</a></div>`
    : "";
  return `<div dir="ltr" style="font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:24px;overflow:hidden;color:#0f172a">
  <div style="background:#000;padding:28px;text-align:center;color:#fff"><div style="font-size:10px;font-weight:900;letter-spacing:.22em;text-transform:uppercase;opacity:.8">${escapeHtml(eyebrow)}</div><h1 style="margin:10px 0 0;font-size:24px">${escapeHtml(title)}</h1></div>
  <div style="padding:36px 30px;line-height:1.65"><p style="font-size:18px;font-weight:800">Hi ${escapeHtml(greeting)},</p>${body}${actionHtml}</div>
  <div style="padding:24px;text-align:center;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:10px;color:#64748b">2026 SiteSnap • Pure Simplicity</div>
</div>`;
}

export function domainEmail(kind, { businessName, domain, recordId }) {
  const selected = `<div style="border:4px solid #000;padding:22px;border-radius:24px;background:#f8faff;margin:24px 0"><div style="font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.2em;color:#64748b">Selected domain</div><div style="font-size:24px;font-weight:900;color:#0070f3;word-break:break-word">${escapeHtml(domain)}</div></div>`;
  const action = { href: `https://trysitesnap.com/success?plan=new&record_id=${encodeURIComponent(recordId)}`, label: "View Order Status →" };
  if (kind === "purchased") {
    return {
      subject: "SiteSnap: Your domain has been secured",
      html: emailFrame({ title: "Your Domain is Secured!", greeting: businessName, body: `<p>Great news — your payment was received and your selected domain has been successfully secured for your website.</p>${selected}<p>We will now continue setting up your website launch. You do not need to take any action right now.</p>`, action })
    };
  }
  if (kind === "processing") {
    return {
      subject: "SiteSnap: Your domain registration is processing",
      html: emailFrame({ title: "Your Domain is Processing", greeting: businessName, body: `<p>Your payment was received, and your domain registration is now being processed.</p>${selected}<p>The domain is not marked as fully secured until registration is confirmed. We are monitoring it and will follow up if anything needs attention.</p>`, action })
    };
  }
  return {
    subject: "SiteSnap: We’re reviewing your domain registration",
    html: emailFrame({ title: "We’re Reviewing Your Domain", greeting: businessName, body: `<p>Your payment was received. We are manually reviewing your domain registration before confirming the setup.</p>${selected}<p>Please do not submit another payment for the same domain. Your order is already in our system.</p>`, action })
  };
}

export function deliveryEmail(kind, { businessName, businessId, domain }) {
  if (kind === "existing") {
    return {
      subject: `${businessId || businessName}, your new web-site is Ready!`,
      html: emailFrame({
        title: "License Activated",
        greeting: businessName,
        body: `<p>Congratulations! Your lifetime license is now active. We prepared your website for <strong>${escapeHtml(domain)}</strong>.</p><p>To bring it live, configure these DNS records at your registrar:</p><div style="border:3px solid #000;border-radius:20px;padding:20px;background:#f8fafc"><strong>A record (@):</strong> 76.76.21.21<br><strong>CNAME (www):</strong> cname.vercel-dns.com</div><p>DNS propagation can take from a few minutes up to 24 hours.</p>`
      })
    };
  }
  return {
    subject: `${businessName}, your new web-site is here!`,
    html: emailFrame({
      title: "Your Website Sketch is Live!",
      greeting: businessName,
      body: `<p>Exciting news! We generated the initial draft of your website.</p><div style="border:4px solid #000;padding:22px;border-radius:24px;background:#f8faff;margin:24px 0"><div style="font-size:10px;font-weight:900;text-transform:uppercase;color:#64748b">Your temporary domain</div><div style="font-size:22px;font-weight:900;color:#0070f3">https://${escapeHtml(domain)}</div></div>`,
      action: { href: `https://${domain}`, label: "View Your Site Draft →" }
    })
  };
}

function trackingScript(recordId) {
  const id = JSON.stringify(recordId);
  const endpoint = JSON.stringify(trackerEndpoint);
  return `<script data-sitesnap-open-tracker>(function(){var r=${id},k="sitesnap-opened:"+r;if(localStorage.getItem(k))return;fetch(${endpoint},{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({record_id:r,opened_at:new Date().toISOString()}),keepalive:true}).then(function(x){if(x.ok)localStorage.setItem(k,"1")}).catch(function(){})})();</script>`;
}

const siteFooter = `<style>.sitesnap-footer-bar{background:#000;color:#fff;padding:14px 18px;text-align:center;font:600 10px/1.5 Inter,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase}.sitesnap-footer-bar a{color:#fff;margin:0 8px}</style><footer class="sitesnap-footer-bar" data-sitesnap-footer>Powered by SiteSnap · <a href="https://trysitesnap.com/checkout">Terms & Privacy</a></footer>`;

export function prepareDeliveredHtml(raw, recordId) {
  let parsed = raw;
  if (typeof parsed === "string") parsed = JSON.parse(parsed);
  if (typeof parsed === "string") parsed = JSON.parse(parsed);
  const first = Array.isArray(parsed?.files) ? parsed.files[0] : null;
  let html = typeof first?.data === "string" ? first.data : typeof parsed?.data === "string" ? parsed.data : "";
  if (!html.trim()) throw new Error("HTML-TAKE2 does not contain a site file");
  html = html
    .replace(/<!-- SITESNAP_WRAPPER_START -->[\s\S]*?<!-- SITESNAP_WRAPPER_END -->/g, "")
    .replace(/\/\* SITESNAP_WRAPPER_START \*\/[\s\S]*?\/\* SITESNAP_WRAPPER_END \*\//g, "")
    .replaceAll("~!DOCTYPE html~", "<!DOCTYPE html>")
    .replace(/```html|```/g, "")
    .replace(/<\/body>\s*<\/html>\s*$/i, "")
    .replace(/<\/body>\s*$/i, "")
    .replace(/<\/html>\s*$/i, "");
  return `${html.trim()}\n${siteFooter}\n${trackingScript(recordId)}\n</body>\n</html>`;
}
