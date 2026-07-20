import { createHmac, timingSafeEqual } from "node:crypto";

const recordIdPattern = /^rec[a-zA-Z0-9]{14}$/;

function text(value, fallback = "") {
  if (Array.isArray(value)) return text(value[0], fallback);
  return String(value ?? fallback).trim();
}

function stripHtml(value) {
  return text(value).replace(/^```html\s*/i, "").replace(/\s*```$/i, "");
}

function cleanHtml(value) {
  const html = stripHtml(value);
  if (!/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html)) {
    throw new Error("The model did not return a complete HTML document");
  }
  return html;
}

function htmlStructureError(html) {
  const lower = html.toLowerCase();
  if (!/<html[\s>]/i.test(html)) return "missing html element";
  if (!/<body[\s>]/i.test(html)) return "missing body element";
  if (lower.lastIndexOf("</body>") < lower.indexOf("<body")) return "missing closing body tag";
  if (lower.lastIndexOf("</html>") < lower.indexOf("<html")) return "missing closing html tag";
  let index = 0;
  while (index < html.length) {
    const start = html.indexOf("<", index);
    if (start < 0) break;
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      if (end < 0) return "unclosed HTML comment";
      index = end + 3;
      continue;
    }
    if (!/[A-Za-z!/?]/.test(html[start + 1] || "")) {
      index = start + 1;
      continue;
    }
    let quote = "";
    let end = start + 1;
    for (; end < html.length; end += 1) {
      const character = html[end];
      if (quote) {
        if (character === quote) quote = "";
        else if (character === "<") return "an HTML tag contains an unclosed quoted attribute";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (end >= html.length) return "an HTML tag is not closed";
    const tag = html.slice(start, end + 1).match(/^<\s*(script|style)\b/i)?.[1]?.toLowerCase();
    if (tag) {
      const close = lower.indexOf(`</${tag}>`, end + 1);
      if (close < 0) return `missing closing ${tag} tag`;
      index = close + tag.length + 3;
    } else {
      index = end + 1;
    }
  }
  return "";
}

function safeJson(value) {
  const normalized = text(value).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  JSON.parse(normalized);
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

function localUsPhone(value) {
  let digits = text(value).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  const display = digits.length === 10
    ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
    : text(value).replace(/^\+1\s*/, "");
  return { digits, display };
}

function publicFacts(facts, testRecipient) {
  const internalEmail = text(testRecipient).toLowerCase();
  const email = text(facts.email);
  return {
    ...facts,
    email: internalEmail && email.toLowerCase() === internalEmail ? "" : email,
    phone: localUsPhone(facts.phone).display
  };
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeGeneratedHtml(rawHtml, facts, suppressedEmails = []) {
  const phone = localUsPhone(facts.phone);
  const location = text(facts.address) || [facts.city, facts.state].filter(Boolean).join(", ");
  let mapInserted = false;
  let html = cleanHtml(rawHtml)
    .replace(/\+1(?=\s*\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4})/g, "")
    .replace(/<form\b[\s\S]*?<\/form>/gi, () => {
      if (!location || mapInserted) return "";
      mapInserted = true;
      return `<div class="sitesnap-inline-map" data-sitesnap-map><iframe title="Map for ${escapeHtml(facts.businessName)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://www.google.com/maps?q=${encodeURIComponent(location)}&output=embed"></iframe></div>`;
    })
    .replace(/<header\b([^>]*)>/i, (tag, attributes) => {
      if (/\bclass\s*=\s*["']/i.test(attributes)) {
        return tag.replace(/(\bclass\s*=\s*["'])([^"']*)/i, "$1$2 sitesnap-brand-header");
      }
      return `<header class="sitesnap-brand-header"${attributes}>`;
    })
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const isLogo = /\balt\s*=\s*["'][^"']*logo/i.test(tag)
        || (facts.logo && tag.includes(facts.logo));
      if (!isLogo) return tag;
      if (/\bclass\s*=\s*["']/i.test(tag)) {
        return tag.replace(/(\bclass\s*=\s*["'])([^"']*)/i, (_match, start, classes) => {
          const safeClasses = classes
            .split(/\s+/)
            .filter((name) => name && name !== "rounded-full" && name !== "object-cover")
            .join(" ");
          return `${start}${safeClasses} sitesnap-brand-logo object-contain`;
        });
      }
      return tag.replace(/^<img/i, '<img class="sitesnap-brand-logo object-contain"');
    });
  if (phone.digits) {
    html = html.replace(/href\s*=\s*(["'])tel:[^"']*\1/gi, `href="tel:${phone.digits}"`);
  }
  if (mapInserted || /data-sitesnap-map/i.test(html)) {
    html = html.replace(/Request\s+(?:a\s+)?Free\s+Quote/gi, "Find Us");
  }
  for (const email of suppressedEmails.map(text).filter(Boolean)) {
    const escaped = regexEscape(email);
    html = html
      .replace(new RegExp(`<a\\b[^>]*href\\s*=\\s*["']mailto:${escaped}[^"']*["'][^>]*>[\\s\\S]*?<\\/a>`, "gi"), "")
      .replace(new RegExp(escaped, "gi"), "");
  }
  return html;
}

function testOpenPayload(recordId, businessName, expiresAt) {
  return `${recordId}\n${businessName}\n${expiresAt}`;
}

function testOpenToken(secret, recordId, businessName, expiresAt) {
  return createHmac("sha256", secret)
    .update(testOpenPayload(recordId, businessName, expiresAt))
    .digest("hex");
}

export function verifyTestOpenToken({ secret, recordId, businessName, expiresAt, token, now = Date.now() }) {
  if (!secret || !recordIdPattern.test(text(recordId)) || !businessName || !token) return false;
  const expires = Number(expiresAt);
  if (!Number.isFinite(expires) || expires < now || expires > now + 32 * 24 * 60 * 60 * 1000) return false;
  const expected = Buffer.from(testOpenToken(secret, recordId, businessName, expires));
  const actual = Buffer.from(text(token));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function rawFacts(fields) {
  return {
    businessName: text(fields["Business Name"]),
    category: text(fields.Category || fields.Type),
    phone: text(fields.Phone),
    website: text(fields.Website),
    address: text(fields.Address || fields["Submitted Address"]),
    city: text(fields.City),
    state: text(fields.State),
    country: text(fields.Country),
    rating: text(fields.Rating),
    reviews: text(fields["Reviews Count"] || fields.Reviews),
    email: text(fields.Email),
    logo: text(fields.Logo || fields["Logo URL"] || fields.logo),
    about: text(fields.About || fields.Description),
    workingHours: fields["Working Hours"] || fields["Working Hours JSON"] || fields["Working hours"] || ""
  };
}

function briefSystem() {
  return `You are a senior brand strategist and website brief writer for American local businesses.
Create a strict JSON brief for a modern, high-converting single-page website. Never invent facts, reviews, ratings, services, licenses, guarantees, awards or business hours. Use verified CRM facts first and research only as supporting context.

Choose one industry-appropriate design archetype, palette, font pair and hero layout. Avoid repetitive black/gold luxury, amber/orange CTAs and generic corporate blue unless the business clearly calls for them. Prefer a clear, accessible, mobile-first design.

Return JSON only with exactly these keys:
{"BUSINESS_NAME":"","INDUSTRY":"","PHONE":"","ADDRESS":"","CITY_COUNTRY":"","TAGLINE":"","ABOUT_US":"","SERVICES":[],"TESTIMONIALS":[],"SOCIAL_PROOF_INSTRUCTIONS":"","imagesArray":[],"DESIGN_ARCHETYPE":"","PALETTE_ID":"","RECOMMENDED_COLORS":[],"PRIMARY_COLOR":"","ACCENT_COLOR":"","BACKGROUND_COLOR":"","TEXT_COLOR":"","FONT_PAIR":"","LAYOUT_VARIANT":"","HERO_STYLE":"","SECTION_STYLE":"","IMAGE_TREATMENT":"","AVOID_COLORS":[],"CLAUDE_DESIGN_INSTRUCTIONS":""}`;
}

function htmlSystem() {
  return `You are an elite front-end developer, UX designer and marketing copywriter. Generate one complete, polished HTML landing page for the supplied local business using Tailwind CSS CDN and Lucide icons.

Return raw HTML only. The page must feel custom-built, be responsive and accessible, and include header, hero, trust proof, services, about, reviews only when supported, contact and footer. Use only supplied facts and image URLs. Never invent claims, testimonials, ratings, licenses, awards, guarantees or hours. Use tel: links and internal anchors; do not link visitors back to the old business website. Do not use tiny body text. Include a valid viewport meta tag and initialize Lucide once.

  In the contact section include a Google Maps iframe when an address exists. Do not create any form: no form endpoint is available, so use only honest call, email and map actions. Keep the primary CTA as Call Now when a phone exists. For US phone numbers, display the local ten-digit format without a visible +1 prefix. Never crop a business logo: use object-contain, preserve its natural aspect ratio, and do not force a circle. Make the header a clearly separate visual surface from the hero and choose its background from the actual logo contrast; transparent logo text must remain clearly readable. Keep a meaningful hero visual visible on mobile. All important mobile tap targets must be at least 44px high.

  Avoid a flat sequence of solid-color rectangles. Use at least three restrained, industry-appropriate background treatments across the page, such as layered gradients, a subtle dot or grid pattern, soft radial glows, or abstract geometric shapes. Vary the treatments without reducing text contrast or making every site look like the same template. Include subtle scroll-reveal motion and a slow hero-image zoom, while respecting prefers-reduced-motion. Include this hidden audit note near the end: <template id="sitesnap-category-note">A short, factual explanation of the design choices for this business category.</template>`;
}

function fallbackWebsite(facts, briefJson, images) {
  const brief = JSON.parse(briefJson);
  const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(text(value)) ? text(value) : fallback;
  const primary = color(brief.PRIMARY_COLOR, "#0f766e");
  const accent = color(brief.ACCENT_COLOR, "#0ea5e9");
  const background = color(brief.BACKGROUND_COLOR, "#f8fafc");
  const phone = localUsPhone(facts.phone);
  const location = text(facts.address) || [facts.city, facts.state].filter(Boolean).join(", ");
  const image = images.find((url) => /^https:\/\//i.test(url)) || "";
  const logo = /^https:\/\//i.test(text(facts.logo)) ? text(facts.logo) : "";
  const serviceValues = Array.isArray(brief.SERVICES) ? brief.SERVICES : [];
  const services = serviceValues.slice(0, 6).map((service) => {
    if (typeof service === "string") return service;
    return text(service?.name || service?.title || service?.service);
  }).filter(Boolean);
  if (!services.length) services.push(facts.category || "Professional Services");
  const tagline = text(brief.TAGLINE) || `Professional ${facts.category || "local"} services you can count on`;
  const about = text(brief.ABOUT_US || facts.about) || `${facts.businessName} serves customers in ${[facts.city, facts.state].filter(Boolean).join(", ") || "the local area"}.`;
  const call = phone.digits ? `<a class="button" href="tel:${escapeHtml(phone.digits)}">Call ${escapeHtml(phone.display)}</a>` : "";
  const email = facts.email ? `<a class="button secondary" href="mailto:${escapeHtml(facts.email)}">Email Us</a>` : "";
  const serviceCards = services.map((service, index) => `<article><span>${String(index + 1).padStart(2, "0")}</span><h3>${escapeHtml(service)}</h3><p>Talk with ${escapeHtml(facts.businessName)} to learn more about this service.</p></article>`).join("");
  const map = location ? `<iframe data-sitesnap-map title="Map for ${escapeHtml(facts.businessName)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://www.google.com/maps?q=${encodeURIComponent(location)}&output=embed"></iframe>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(facts.businessName)}</title><style>
:root{--primary:${primary};--accent:${accent};--bg:${background};--ink:#0f172a}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--ink);background:var(--bg);font:16px/1.65 Inter,Arial,sans-serif}a{color:inherit}header{position:relative;z-index:2;background:#fff;border-bottom:1px solid #dbe3ea}header>div,section>div,footer>div{width:min(1120px,calc(100% - 40px));margin:auto}.nav{min-height:76px;display:flex;align-items:center;justify-content:space-between;gap:24px}.brand{display:flex;align-items:center;gap:14px;font-size:20px;font-weight:900;text-decoration:none}.brand img{width:auto;max-width:180px;height:52px;object-fit:contain;border-radius:0}.nav nav{display:flex;gap:22px}.nav nav a{text-decoration:none;font-weight:750}.hero{position:relative;isolation:isolate;overflow:hidden;background:linear-gradient(135deg,var(--primary),#082f49);color:#fff}.hero:after{content:"";position:absolute;inset:0;z-index:-1;background:radial-gradient(circle at 85% 15%,rgba(255,255,255,.2),transparent 34%),radial-gradient(circle at 10% 90%,rgba(255,255,255,.12),transparent 32%)}.hero-grid{min-height:560px;display:grid;grid-template-columns:1.05fr .95fr;align-items:center;gap:54px;padding:74px 0}.eyebrow{text-transform:uppercase;letter-spacing:.14em;font-weight:850;color:#bae6fd}.hero h1{font-size:clamp(42px,6vw,76px);line-height:1.02;margin:12px 0 24px}.hero p{font-size:20px;max-width:650px;color:#e2e8f0}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:30px}.button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:12px 22px;border-radius:999px;background:var(--accent);color:#fff;text-decoration:none;font-weight:900}.button.secondary{background:transparent;border:2px solid currentColor}.hero img{width:100%;height:420px;object-fit:cover;border-radius:28px;box-shadow:0 28px 70px rgba(0,0,0,.3);animation:zoom 12s ease-in-out infinite alternate}.services{padding:82px 0;background-image:radial-gradient(rgba(15,118,110,.14) 1px,transparent 1px);background-size:24px 24px}.section-title{max-width:720px;margin-bottom:34px}.section-title h2{font-size:clamp(32px,5vw,52px);line-height:1.1;margin:8px 0}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.cards article{background:#fff;border:1px solid #dbe3ea;border-radius:22px;padding:28px;box-shadow:0 14px 38px rgba(15,23,42,.08);transition:.3s}.cards article:hover{transform:translateY(-5px)}.cards span{color:var(--accent);font-weight:950}.cards h3{font-size:22px;margin:10px 0}.about{padding:82px 0;background:radial-gradient(circle at 100% 0%,color-mix(in srgb,var(--accent) 18%,transparent),transparent 40%),#fff}.about-grid,.contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:60px;align-items:center}.about h2,.contact h2{font-size:clamp(32px,5vw,50px);line-height:1.12;margin:8px 0 20px}.fact{border-left:5px solid var(--accent);padding:18px 22px;background:var(--bg);border-radius:0 18px 18px 0}.contact{padding:82px 0;background:linear-gradient(135deg,#e0f2fe,#f8fafc)}.contact iframe{width:100%;height:390px;border:0;border-radius:24px;box-shadow:0 18px 45px rgba(15,23,42,.14)}footer{background:#062f26;color:#dbe7e2;padding:44px 0}footer h2{color:#fff;margin:0 0 8px}.footer-row{display:flex;justify-content:space-between;gap:30px;align-items:flex-start}.reveal{animation:rise .8s ease both}@keyframes rise{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:none}}@keyframes zoom{from{transform:scale(1)}to{transform:scale(1.04)}}@media(max-width:760px){.nav nav{display:none}.hero-grid,.about-grid,.contact-grid{grid-template-columns:1fr}.hero-grid{padding:56px 0;min-height:0}.hero img{height:280px}.cards{grid-template-columns:1fr}.footer-row{flex-direction:column}.hero h1{font-size:44px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
</style></head><body><header><div class="nav">${logo ? `<a class="brand" href="#top"><img src="${escapeHtml(logo)}" alt="${escapeHtml(facts.businessName)} logo"><span>${escapeHtml(facts.businessName)}</span></a>` : `<a class="brand" href="#top">${escapeHtml(facts.businessName)}</a>`}<nav><a href="#services">Services</a><a href="#about">About</a><a href="#contact">Contact</a></nav></div></header><main id="top"><section class="hero"><div class="hero-grid"><div class="reveal"><div class="eyebrow">${escapeHtml(facts.category || "Local business")}</div><h1>${escapeHtml(tagline)}</h1><p>${escapeHtml(about)}</p><div class="actions">${call}${email}</div></div>${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(facts.category || facts.businessName)}">` : ""}</div></section><section id="services" class="services"><div><div class="section-title"><div class="eyebrow" style="color:var(--primary)">What we do</div><h2>Services built around your needs</h2></div><div class="cards">${serviceCards}</div></div></section><section id="about" class="about"><div class="about-grid"><div><div class="eyebrow" style="color:var(--primary)">About us</div><h2>Local service. Clear communication.</h2><p>${escapeHtml(about)}</p></div><div class="fact"><strong>${escapeHtml(facts.businessName)}</strong><br>${escapeHtml(location || facts.category || "Local business")}</div></div></section><section id="contact" class="contact"><div class="contact-grid"><div><div class="eyebrow" style="color:var(--primary)">Contact</div><h2>Ready to get started?</h2>${location ? `<p>${escapeHtml(location)}</p>` : ""}<div class="actions">${call}${email}</div></div>${map}</div></section></main><footer><div class="footer-row"><div><h2>${escapeHtml(facts.businessName)}</h2><div>${escapeHtml(facts.category || "Local service")}</div></div><div>${phone.display ? `<a href="tel:${escapeHtml(phone.digits)}">${escapeHtml(phone.display)}</a>` : ""}${facts.email ? `<br><a href="mailto:${escapeHtml(facts.email)}">${escapeHtml(facts.email)}</a>` : ""}</div></div></footer><template id="sitesnap-category-note">The fallback design uses verified business facts, accessible contrast, mobile-first layout and restrained visual depth appropriate for ${escapeHtml(facts.category || "this local business")}.</template></body></html>`;
}

function auditSystem() {
  return `You are a senior HTML QA engineer. Repair the supplied HTML with minimal changes. Preserve its design, copy, structure, colors and section order. Return one complete raw HTML document only.

  Fix incomplete tags, invalid links, contrast/accessibility problems, broken image URLs, mobile overflow and missing Lucide initialization. Remove unsupported claims, placeholder content and every form because no functional form endpoint is supplied. When an address exists, retain a Google Maps iframe plus honest call/email actions. Never invent facts. Keep only supplied image URLs. Ensure phone links match the verified phone and use local ten-digit display without a visible +1 prefix. Never crop logos or force them into circles; use object-contain and preserve their aspect ratio. Make the header visually separate from the hero and verify that the real transparent logo has strong contrast against it. Keep the hero visual available on mobile, make important tap targets at least 44px high, retain at least three restrained background treatments rather than flat solid-color sections, and retain accessible motion with prefers-reduced-motion support. Preserve the hidden sitesnap-category-note template.`;
}

function researchText(research) {
  const results = (research.results || []).slice(0, 10).map((item) => ({
    title: item.title,
    url: item.url,
    content: text(item.content || item.raw_content).slice(0, 4500)
  }));
  return JSON.stringify({ answer: research.answer || "", images: research.images || [], results }).slice(0, 48000);
}

function pexelsImages(pexels) {
  return (pexels.photos || []).map((photo) => photo.src?.large || photo.src?.landscape).filter(Boolean);
}

function injectSiteSnapControls(rawHtml, recordId, facts, { trackOpen = true, testMode = false, testSecret = "", suppressedEmails = [] } = {}) {
  const html = normalizeGeneratedHtml(rawHtml, facts, suppressedEmails);
  const category = html.match(/<template id="sitesnap-category-note">\s*([\s\S]*?)\s*<\/template>/i)?.[1] || "This design was tailored to the business category, local audience and verified brand cues.";
  const location = text(facts.address) || [facts.city, facts.state].filter(Boolean).join(", ");
  const phone = localUsPhone(facts.phone);
  const contact = /id=["']contact["']/i.test(html) ? "" : `<section id="contact" style="padding:72px 20px;background:#f8fafc;color:#0f172a;font-family:Inter,system-ui,sans-serif"><div style="max-width:900px;margin:auto;text-align:center"><p style="font-weight:800;color:#0070f3;text-transform:uppercase;letter-spacing:.14em">Contact</p><h2 style="font-size:clamp(30px,5vw,48px);margin:8px 0 18px">Ready to talk?</h2>${location ? `<p style="font-size:18px">${escapeHtml(location)}</p>` : ""}<div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center;margin-top:28px">${phone.digits ? `<a href="tel:${escapeHtml(phone.digits)}" style="background:#0070f3;color:#fff;padding:15px 24px;border-radius:999px;text-decoration:none;font-weight:800">Call ${escapeHtml(phone.display)}</a>` : ""}${facts.email ? `<a href="mailto:${escapeHtml(facts.email)}" style="border:2px solid #0f172a;color:#0f172a;padding:13px 24px;border-radius:999px;text-decoration:none;font-weight:800">Email Us</a>` : ""}</div></div></section>`;
  const hasMap = /data-sitesnap-map|google\.com\/maps|maps\.google/i.test(html);
  const mapBlock = location && !hasMap ? `<section id="sitesnap-location" class="sitesnap-location-section" data-sitesnap-map><div><p>Our Location</p><h2>Find ${escapeHtml(facts.businessName)}</h2><address>${escapeHtml(location)}</address><iframe title="Map for ${escapeHtml(facts.businessName)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://www.google.com/maps?q=${encodeURIComponent(location)}&output=embed"></iframe></div></section>` : "";
  let tracker = trackOpen ? `<script data-sitesnap-open-tracker>(function(){var s=document.currentScript,r=${JSON.stringify(recordId)},k="sitesnap-opened:"+r;if(localStorage.getItem(k)){s.dataset.sitesnapOpenStatus="duplicate";return}s.dataset.sitesnapOpenStatus="pending";fetch("https://trysitesnap.com/api/3b7f5316669d40c19e243c38f67b52ec",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({record_id:r,business_name:${JSON.stringify(facts.businessName)},opened_at:new Date().toISOString()}),keepalive:true}).then(function(x){if(x.ok){localStorage.setItem(k,"1");s.dataset.sitesnapOpenStatus="recorded"}else{s.dataset.sitesnapOpenStatus="failed"}}).catch(function(){s.dataset.sitesnapOpenStatus="failed"})})();</script>` : "";
  if (testMode && testSecret) {
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const token = testOpenToken(testSecret, recordId, facts.businessName, expiresAt);
    tracker = `<script data-sitesnap-open-tracker data-sitesnap-test="true">(function(){var s=document.currentScript,r=${JSON.stringify(recordId)},b=${JSON.stringify(facts.businessName)},e=${expiresAt},t=${JSON.stringify(token)},k="sitesnap-test-opened:"+r+":"+t.slice(0,8);if(localStorage.getItem(k)){s.dataset.sitesnapOpenStatus="duplicate";return}s.dataset.sitesnapOpenStatus="pending";fetch("https://trysitesnap.com/api/04-first-sketch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({event:"test_open",record_id:r,business_name:b,expires:e,token:t,opened_at:new Date().toISOString(),page_url:location.href}),keepalive:true}).then(function(x){if(x.ok){localStorage.setItem(k,"1");s.dataset.sitesnapOpenStatus="recorded"}else{s.dataset.sitesnapOpenStatus="failed"}}).catch(function(){s.dataset.sitesnapOpenStatus="failed"})})();</script>`;
  }
  const legacyBlock = `<style data-sitesnap-preview>.sitesnap-preview-cta{position:fixed;right:20px;bottom:20px;z-index:9999;background:#0070f3;color:#fff;border-radius:999px;padding:13px 20px;text-decoration:none;font:800 14px/1.2 Inter,system-ui,sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.28)}.sitesnap-preview-note{max-width:900px;margin:0 auto;padding:28px 20px;color:#334155;font:500 14px/1.6 Inter,system-ui,sans-serif}</style>
${contact}
<div class="sitesnap-preview-note" data-sitesnap-design-note>${escapeHtml(category)}</div>
<a class="sitesnap-preview-cta" href="https://trysitesnap.com/finalize?record_id=${encodeURIComponent(recordId)}" target="_blank" rel="noopener noreferrer">Personalize This Sketch →</a>
${tracker}`;
  void legacyBlock;
  const finalizeUrl = `https://trysitesnap.com/finalize?record_id=${encodeURIComponent(recordId)}&business_name=${encodeURIComponent(facts.businessName)}`;
  const block = `<style data-sitesnap-preview>
.sitesnap-brand-logo{object-fit:contain!important;border-radius:8px!important;background:rgba(255,255,255,.96)!important;padding:4px!important;filter:drop-shadow(0 1px 2px rgba(15,23,42,.2))}
.sitesnap-brand-header{background:#f8fafc!important;color:#0f172a!important;border-bottom:1px solid #cbd5e1!important;box-shadow:0 8px 24px rgba(15,23,42,.12)!important}
.sitesnap-brand-header nav a:not([href^="tel:"]){color:#1e293b!important}.sitesnap-brand-header button{color:#1e293b!important}
footer:not([data-sitesnap-footer]){background:#062f26!important;color:#f8fafc!important;border-top:1px solid rgba(255,255,255,.14)!important}footer:not([data-sitesnap-footer]) h1,footer:not([data-sitesnap-footer]) h2,footer:not([data-sitesnap-footer]) h3,footer:not([data-sitesnap-footer]) h4,footer:not([data-sitesnap-footer]) strong,footer:not([data-sitesnap-footer]) a:not([href^="tel:"]){color:#fff!important}footer:not([data-sitesnap-footer]) p,footer:not([data-sitesnap-footer]) span,footer:not([data-sitesnap-footer]) li{color:#dbe7e2!important}footer:not([data-sitesnap-footer]) a[href^="tel:"]{color:#f59e0b!important}footer:not([data-sitesnap-footer]) [class*="border-"]{border-color:rgba(255,255,255,.16)!important}
.sitesnap-inline-map{width:100%;min-height:360px;overflow:hidden;border-radius:24px;box-shadow:0 18px 48px rgba(15,23,42,.14)}.sitesnap-inline-map iframe{display:block;width:100%;height:100%;min-height:360px;border:0}
.sitesnap-location-section{padding:72px 20px;background:#f8fafc;color:#0f172a;font-family:Inter,system-ui,sans-serif}.sitesnap-location-section>div{max-width:1100px;margin:auto;text-align:center}.sitesnap-location-section p{margin:0;color:#0070f3;font-weight:800;text-transform:uppercase;letter-spacing:.14em}.sitesnap-location-section h2{margin:8px 0 8px;font-size:clamp(30px,5vw,48px)}.sitesnap-location-section address{margin-bottom:28px;font-style:normal;font-size:18px}.sitesnap-location-section iframe{display:block;width:100%;height:360px;border:0;border-radius:24px;box-shadow:0 18px 48px rgba(15,23,42,.14)}
.sitesnap-pattern-dots{background-image:radial-gradient(rgba(15,23,42,.09) 1.2px,transparent 1.2px)!important;background-size:22px 22px!important}.sitesnap-pattern-radial{background-image:radial-gradient(circle at 100% 0%,rgba(14,165,233,.16),transparent 42%),radial-gradient(circle at 0% 100%,rgba(16,185,129,.12),transparent 38%)!important}.sitesnap-pattern-grid{background-image:linear-gradient(rgba(15,23,42,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(15,23,42,.055) 1px,transparent 1px)!important;background-size:32px 32px!important}
.sitesnap-preview-cta{position:fixed;right:20px;bottom:20px;z-index:9999;min-height:44px;border:0;background:#0070f3;color:#fff;border-radius:999px;padding:12px 20px;font:800 14px/1.2 Inter,system-ui,sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.28);cursor:pointer}
.sitesnap-design-notes-overlay{position:fixed;inset:0;z-index:10000;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(15,23,42,.72)}
.sitesnap-design-notes-overlay[data-open="true"]{display:flex}.sitesnap-design-notes-card{position:relative;width:min(620px,100%);max-height:85vh;overflow:auto;border-radius:24px;background:#fff;padding:32px;color:#0f172a;box-shadow:0 25px 70px rgba(0,0,0,.35);font:500 16px/1.65 Inter,system-ui,sans-serif}.sitesnap-design-notes-close{position:absolute;right:14px;top:10px;border:0;background:transparent;font-size:28px;cursor:pointer;min-width:44px;min-height:44px}
#finalize-section{clear:both;padding:70px 20px;border-top:5px solid #facc15;background:#0070f3;text-align:center;font-family:Inter,system-ui,sans-serif}#finalize-section h2{margin:0 0 18px;color:#facc15;font-size:clamp(32px,6vw,48px);font-weight:900}#finalize-section p{max-width:800px;margin:0 auto 30px;color:#fff;font-size:18px;line-height:1.65}#finalize-section a{display:inline-flex;align-items:center;justify-content:center;min-height:48px;border-radius:999px;background:#facc15;color:#0754b8;padding:14px 28px;text-decoration:none;font-weight:900}
.sitesnap-reveal{opacity:0;transform:translateY(28px);transition:opacity .9s ease,transform .9s ease}.sitesnap-reveal.sitesnap-visible{opacity:1;transform:none}.sitesnap-hero-image{animation:sitesnap-hero-zoom 12s ease-in-out infinite alternate}@keyframes sitesnap-hero-zoom{from{transform:scale(1)}to{transform:scale(1.045)}}
@media(max-width:480px){.sitesnap-preview-cta{right:16px;bottom:16px}.sitesnap-design-notes-card{padding:28px 22px}#finalize-section{padding:56px 18px}}
@media(prefers-reduced-motion:reduce){.sitesnap-reveal{opacity:1;transform:none;transition:none}.sitesnap-hero-image{animation:none!important}}
</style>
${contact}
${mapBlock}
<button class="sitesnap-preview-cta" type="button" aria-haspopup="dialog" aria-controls="sitesnap-design-notes">&#128161; Why this sketch?</button>
<div id="sitesnap-design-notes" class="sitesnap-design-notes-overlay" role="dialog" aria-modal="true" aria-labelledby="sitesnap-design-notes-title"><div class="sitesnap-design-notes-card"><button class="sitesnap-design-notes-close" type="button" aria-label="Close">&times;</button><h2 id="sitesnap-design-notes-title" style="font-size:30px;font-weight:900;margin:0 0 12px">A quick note about this sketch</h2><p data-sitesnap-design-note>${escapeHtml(category)}</p><p>This first version was designed around the verified business details, local audience and the actions customers are most likely to take.</p><a href="${finalizeUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;min-height:48px;align-items:center;border-radius:999px;background:#0070f3;color:white;padding:12px 22px;text-decoration:none;font-weight:900">Personalize this sketch &rarr;</a></div></div>
<section id="finalize-section"><h2>Ready to Take This Live?</h2><p>We crafted this website preview especially for <strong>${escapeHtml(facts.businessName)}</strong>. It combines verified business information, local relevance and a mobile-first structure. Ready to add final details and start accepting leads?</p><a href="${finalizeUrl}" target="_blank" rel="noopener noreferrer">Finalize My Website Now &rarr;</a></section>
<script data-sitesnap-experience>(function(){var o=document.getElementById("sitesnap-design-notes"),b=document.querySelector(".sitesnap-preview-cta"),c=document.querySelector(".sitesnap-design-notes-close");function set(v){o.dataset.open=v?"true":"false";if(v)c.focus();else b.focus()}b.addEventListener("click",function(){set(true)});c.addEventListener("click",function(){set(false)});o.addEventListener("click",function(e){if(e.target===o)set(false)});document.addEventListener("keydown",function(e){if(e.key==="Escape"&&o.dataset.open==="true")set(false)});var sections=[].slice.call(document.querySelectorAll("section")).filter(function(x){return x.id!=="finalize-section"&&x.id!=="sitesnap-location"});var patterns=["sitesnap-pattern-radial","sitesnap-pattern-dots","sitesnap-pattern-grid"];sections.forEach(function(x,i){if(getComputedStyle(x).backgroundImage==="none")x.classList.add(patterns[i%patterns.length])});sections.slice(1).forEach(function(x){x.classList.add("sitesnap-reveal")});if("IntersectionObserver" in window){var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add("sitesnap-visible");io.unobserve(e.target)}})},{threshold:.08});sections.slice(1).forEach(function(x){io.observe(x)})}else{sections.forEach(function(x){x.classList.add("sitesnap-visible")})}var hero=sections[0]&&sections[0].querySelector("img");if(hero)hero.classList.add("sitesnap-hero-image")})();</script>
${tracker}`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${block}\n</body>`) : `${html}\n${block}`;
}

function deploymentPayload(html) {
  return JSON.stringify({
    name: "corp-preview",
    files: [{ file: "index.html", data: html }],
    projectSettings: { framework: null }
  });
}

async function runStage(stage, timings, task) {
  const startedAt = Date.now();
  try {
    return await task();
  } catch (error) {
    if (!error.code) error.code = `SCENARIO_04_${stage.toUpperCase()}_FAILED`;
    error.stage = stage;
    throw error;
  } finally {
    timings[stage] = Date.now() - startedAt;
  }
}

function stripInjectedSiteSnapControls(rawHtml) {
  return cleanHtml(rawHtml).replace(
    /<style\b[^>]*data-sitesnap-preview[^>]*>[\s\S]*?<script\b[^>]*data-sitesnap-open-tracker[^>]*>[\s\S]*?<\/script>\s*/gi,
    ""
  );
}

function sketchEmail({ businessName, url, recordId, testMode, corrected = false }) {
  const notice = testMode
    ? `<div style="background:#fff4cc;border:1px solid #e4c34d;padding:14px 16px;margin-bottom:24px"><strong>SiteSnap scenario 04 test</strong><br>This message was redirected to the approved test inbox and was not sent to the customer.</div>`
    : "";
  return {
    subject: `${testMode ? `[SiteSnap 04 Test${corrected ? " — Corrected" : ""}] ` : ""}Hi ${businessName}, your site sketch is here!`,
    html: `<div dir="ltr" style="font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:24px;overflow:hidden;color:#0f172a">
      <div style="background:#000;padding:30px 20px;text-align:center;color:#fff"><div style="font-size:10px;font-weight:900;letter-spacing:.25em;text-transform:uppercase">SiteSnap • Pure Simplicity</div><h1 style="font-size:24px">Your Website Sketch is Ready!</h1></div>
      <div style="padding:36px 30px;line-height:1.65">${notice}<p style="font-size:18px;font-weight:800">Hi ${escapeHtml(businessName)},</p><p>Exciting news! We generated the initial draft of your website. This first sketch shows the design, structure and mobile experience prepared for your business.</p><div style="text-align:center;margin:36px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#0070f3;color:#fff;padding:17px 32px;border-radius:999px;text-decoration:none;font-weight:900">View Your Site Draft →</a></div><div style="border:3px solid #000;padding:24px;border-radius:24px;background:#f8fafc"><strong>What’s next?</strong><p>Review the draft, then request revisions or continue to finalize your website.</p><a href="https://trysitesnap.com/finalize?record_id=${encodeURIComponent(recordId)}" style="color:#0070f3;font-weight:800">Personalize this sketch →</a></div></div>
      <div style="background:#f8fafc;padding:24px;text-align:center;font-size:10px;color:#64748b">2026 SiteSnap • Pure Simplicity</div>
    </div>`
  };
}

function screenshotUrl(accessKey, target, page2 = false) {
  if (!accessKey || !target) return "";
  const url = new URL("https://api.screenshotone.com/take");
  url.searchParams.set("access_key", accessKey);
  url.searchParams.set("url", target);
  url.searchParams.set("viewport_width", "375");
  url.searchParams.set("viewport_height", "812");
  url.searchParams.set("device_scale_factor", "3");
  url.searchParams.set("block_cookie_banners", "true");
  url.searchParams.set("block_chats", "true");
  if (page2) {
    url.searchParams.set("delay", "3");
    url.searchParams.set("scripts", "window.scrollTo(0,650)");
  }
  return url.toString();
}

export async function runFirstSketch(recordId, dependencies, options = {}) {
  const id = text(recordId);
  if (!recordIdPattern.test(id)) throw new Error("Invalid Airtable record ID");
  const { airtable, tavily, pexels, sketchBrief, sketchHtml, sketchAudit, vercelDelivery, mail, config } = dependencies;
  if (!mail) throw new Error("Mail relay is not configured");
  const timings = {};

  const job = await runStage("airtable_job", timings, () => airtable.getRecord(id));
  const jobFields = job.fields || {};
  const existingDraft = text(jobFields["Draft Site URL"]);
  if (!options.testMode && existingDraft) {
    return {
      success: true,
      duplicate: true,
      testMode: false,
      recordId: id,
      businessName: text(jobFields["Business Name"], "Customer"),
      recipient: text(jobFields["Customer Email"]),
      emailRedirected: false,
      draftUrl: /^https?:\/\//i.test(existingDraft) ? existingDraft : `https://${existingDraft}`,
      airtableUpdated: false,
      notificationSent: false
    };
  }
  const businessId = text(jobFields["Business ID"]);
  if (!recordIdPattern.test(businessId)) throw new Error("Generation Job has no valid Raw Outscraper record ID");
  const raw = await runStage("airtable_business", timings, () => airtable.getRecordFromTable(config.airtable.rawOutscraperTableId, businessId));
  const facts = rawFacts(raw.fields || {});
  facts.businessName ||= text(jobFields["Business Name"]);
  if (!facts.businessName) throw new Error("Business name is missing");
  const siteFacts = publicFacts(facts, config.firstSketch.testRecipient);

  const [research, stock] = await runStage("research", timings, () => Promise.all([
    tavily.search(`Official website, portfolio, customer reviews and professional assets for ${facts.businessName} (${facts.category}) in ${facts.address || `${facts.city}, ${facts.state}`}. Prefer official sources and direct image links.`),
    pexels.search([facts.category, facts.city, facts.state].filter(Boolean).join(", "), (id.charCodeAt(id.length - 1) % 8) + 1)
  ]));
  const brief = safeJson(await runStage("brief", timings, () => sketchBrief.generate({
    system: briefSystem(),
    user: `VERIFIED_CRM:\n${JSON.stringify(siteFacts)}\n\nRESEARCH:\n${researchText(research)}\n\nCreate the strict website brief.`,
    maxTokens: 4096,
    temperature: 0.3,
    json: true
  })));
  const images = [...new Set([...(research.images || []), ...pexelsImages(stock)])].filter((url) => /^https:\/\//i.test(url)).slice(0, 30);
  const claudeOutput = stripHtml(await runStage("html", timings, () => sketchHtml.generate({
    system: htmlSystem(),
    user: `WEBSITE_BRIEF:\n${brief}\n\nVERIFIED_CRM:\n${JSON.stringify(siteFacts)}\n\nALLOWED_IMAGES:\n${JSON.stringify(images)}\n\nGenerate the complete website. Keep it polished but concise: 5-7 sections and under 4,800 output tokens. Finish the entire document including closing body and html tags before adding optional details.`,
    maxTokens: 5500,
    temperature: 0.4
  })));
  let geminiOutput = claudeOutput;
  let structureError = htmlStructureError(geminiOutput);
  let auditUsed = false;
  let fallbackUsed = false;
  if (structureError) {
    auditUsed = true;
    geminiOutput = stripHtml(await runStage("html_repair_1", timings, () => sketchAudit.generate({
      system: auditSystem(),
      user: `MALFORMED_HTML:\n${geminiOutput}\n\nWEBSITE_BRIEF:\n${brief}\n\nVERIFIED_CRM:\n${JSON.stringify(siteFacts)}\n\nALLOWED_IMAGES:\n${JSON.stringify(images)}\n\nThe generated website is structurally invalid (${structureError}). Return a complete, valid HTML document. Close every quote and tag, preserve the intended page, remove unsupported content, and do not truncate the response.`,
      maxTokens: 6000,
      temperature: 0.1
    })));
    structureError = htmlStructureError(geminiOutput);
    if (structureError) {
      geminiOutput = stripHtml(await runStage("html_repair_2", timings, () => sketchAudit.generate({
        system: auditSystem(),
        user: `SECOND_REPAIR_HTML:\n${geminiOutput}\n\nVERIFIED_CRM:\n${JSON.stringify(siteFacts)}\n\nThe first repair is still invalid (${structureError}). Return one shorter, complete HTML document. Close every quote and tag and do not truncate the response.`,
        maxTokens: 5000,
        temperature: 0
      })));
      structureError = htmlStructureError(geminiOutput);
    }
  }
  if (structureError) {
    fallbackUsed = true;
    geminiOutput = fallbackWebsite(siteFacts, brief, images);
    structureError = htmlStructureError(geminiOutput);
    if (structureError) {
      const error = new Error(`The fallback website HTML is malformed: ${structureError}`);
      error.code = "SCENARIO_04_HTML_INVALID";
      error.stage = "html_validation";
      throw error;
    }
  }
  const finalHtml = injectSiteSnapControls(geminiOutput, id, siteFacts, {
    trackOpen: !options.testMode,
    testMode: Boolean(options.testMode),
    testSecret: process.env.LOCAL_TELEGRAM_RELAY_SECRET || "",
    suppressedEmails: [config.firstSketch.testRecipient]
  });
  const payload = deploymentPayload(finalHtml);
  const deployment = await runStage("deploy", timings, () => vercelDelivery.deployHtml(finalHtml, config.vercelDelivery.projectName));
  if (!deployment.id || !deployment.url) throw new Error("Vercel did not return a deployment ID and URL");
  await runStage("deploy_ready", timings, () => vercelDelivery.waitUntilReady(deployment.id, { attempts: 45, intervalMs: 1500 }));
  const draftUrl = `https://${text(deployment.url).replace(/^https?:\/\//, "")}`;

  if (!options.testMode) {
    const fields = config.firstSketch.fields;
    const update = {
      [fields.customerEmail]: facts.email,
      [fields.geminiOutput]: geminiOutput,
      [fields.claudeOutput]: claudeOutput,
      [fields.draftSiteUrl]: text(deployment.url),
      [fields.htmlTake1]: payload,
      [fields.researchBrief]: brief
    };
    const newSite = screenshotUrl(process.env.SCREENSHOTONE_ACCESS_KEY, draftUrl);
    const newSitePage2 = screenshotUrl(process.env.SCREENSHOTONE_ACCESS_KEY, draftUrl, true);
    const oldSite = screenshotUrl(process.env.SCREENSHOTONE_ACCESS_KEY, facts.website);
    if (newSite) update[fields.newSite] = [{ url: newSite }];
    if (newSitePage2) update[fields.newSitePage2] = [{ url: newSitePage2 }];
    if (oldSite) update[fields.oldSite] = [{ url: oldSite }];
    await runStage("airtable_update", timings, () => airtable.updateRecord(id, update));
  }

  const emailRedirected = Boolean(options.testMode || options.redirectEmail);
  const recipient = emailRedirected ? config.firstSketch.testRecipient : facts.email;
  if (!recipient) throw new Error("No email recipient is available");
  const email = sketchEmail({ businessName: facts.businessName, url: draftUrl, recordId: id, testMode: emailRedirected });
  await runStage("email", timings, () => mail.send({ to: recipient, ...email }));
  return {
    success: true,
    testMode: Boolean(options.testMode),
    recordId: id,
    rawRecordId: businessId,
    businessName: facts.businessName,
    recipient,
    emailRedirected,
    draftUrl,
    deploymentId: deployment.id,
    auditUsed,
    fallbackUsed,
    timings,
    airtableUpdated: !options.testMode,
    notificationSent: false
  };
}

export async function resendFirstSketchTestEmail(dependencies, input = {}) {
  const id = text(input.recordId);
  if (!recordIdPattern.test(id)) throw new Error("Invalid Airtable record ID");
  const businessName = text(input.businessName);
  if (!businessName || businessName.length > 200) throw new Error("Invalid business name");
  const parsed = new URL(text(input.draftUrl));
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".vercel.app")) throw new Error("Invalid preview URL");
  if (!dependencies.mail) throw new Error("Mail relay is not configured");
  const email = sketchEmail({ businessName, url: parsed.toString(), recordId: id, testMode: true, corrected: true });
  await dependencies.mail.send({ to: dependencies.config.firstSketch.testRecipient, ...email });
  return { success: true, testMode: true, emailOnly: true, recordId: id, businessName, recipient: dependencies.config.firstSketch.testRecipient, draftUrl: parsed.toString() };
}

export async function repairFirstSketchTest(dependencies, input = {}) {
  const id = text(input.recordId);
  if (!recordIdPattern.test(id)) throw new Error("Invalid Airtable record ID");
  const parsed = new URL(text(input.sourceUrl));
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".vercel.app")) {
    throw new Error("Invalid preview URL");
  }
  const { airtable, vercelDelivery, mail, config } = dependencies;
  if (!mail) throw new Error("Mail relay is not configured");
  const job = await airtable.getRecord(id);
  const jobFields = job.fields || {};
  const businessId = text(jobFields["Business ID"]);
  if (!recordIdPattern.test(businessId)) throw new Error("Generation Job has no valid Raw Outscraper record ID");
  const raw = await airtable.getRecordFromTable(config.airtable.rawOutscraperTableId, businessId);
  const facts = rawFacts(raw.fields || {});
  facts.businessName ||= text(jobFields["Business Name"]);
  if (!facts.businessName) throw new Error("Business name is missing");
  const sourceHtml = dependencies.fetchHtml
    ? await dependencies.fetchHtml(parsed.href)
    : await (async () => {
        const response = await fetch(parsed.href, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`Could not load preview HTML (${response.status})`);
        return response.text();
      })();
  const siteFacts = publicFacts(facts, config.firstSketch.testRecipient);
  const finalHtml = injectSiteSnapControls(stripInjectedSiteSnapControls(sourceHtml), id, siteFacts, {
    trackOpen: false,
    testMode: true,
    testSecret: process.env.LOCAL_TELEGRAM_RELAY_SECRET || "",
    suppressedEmails: [config.firstSketch.testRecipient]
  });
  const deployment = await vercelDelivery.deployHtml(finalHtml, config.vercelDelivery.projectName);
  if (!deployment.id || !deployment.url) throw new Error("Vercel did not return a deployment ID and URL");
  await vercelDelivery.waitUntilReady(deployment.id, { attempts: 45, intervalMs: 1500 });
  const draftUrl = `https://${text(deployment.url).replace(/^https?:\/\//, "")}`;
  const recipient = config.firstSketch.testRecipient;
  await mail.send({
    to: recipient,
    ...sketchEmail({ businessName: facts.businessName, url: draftUrl, recordId: id, testMode: true, corrected: true })
  });
  return {
    success: true,
    repaired: true,
    testMode: true,
    recordId: id,
    rawRecordId: businessId,
    businessName: facts.businessName,
    recipient,
    emailRedirected: true,
    draftUrl,
    deploymentId: deployment.id,
    airtableUpdated: false,
    notificationSent: false
  };
}

export async function runFirstSketchQueue(dependencies, options = {}) {
  const cutover = text(options.cutoverAt);
  if (!cutover || !Number.isFinite(Date.parse(cutover))) throw new Error("SCENARIO_04_CUTOVER_AT is not configured");
  const formula = `AND({Business Name}!="",{Draft Site URL}="",IS_AFTER(CREATED_TIME(),'${cutover}'))`;
  const records = await dependencies.airtable.listRecords(dependencies.config.airtable.tableId, {
    filterByFormula: formula,
    maxRecords: 20,
    sort: [{ field: "Created At", direction: "asc" }]
  });
  const candidate = records.find((record) => recordIdPattern.test(text(record.fields?.["Business ID"])));
  if (!candidate) return { success: true, processed: 0 };
  return { processed: 1, ...(await runFirstSketch(candidate.id, dependencies)) };
}
