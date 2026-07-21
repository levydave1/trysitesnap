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

function lucideIconName(token) {
  const key = String(token || "").toUpperCase();
  const icons = {
    PHONE: "phone", LOCATION: "map-pin", MAP_PIN: "map-pin", MAP: "map-pin",
    STAR: "star", CHECK: "check", SERVICE: "list-checks", HEART: "heart",
    CLOCK: "clock", MAIL: "mail", USER: "user", SHIELD: "shield-check",
    HOME: "house", HOUSE: "house", BUILDING: "building-2", CALENDAR: "calendar-check",
    TRUCK: "truck", TOOL: "wrench", FOOD: "utensils", PET: "paw-print",
    BEAUTY: "sparkles", STORM: "cloud-lightning", ALERT: "triangle-alert",
    DROPLET: "droplets", SPARKLE: "sparkles", SPARKLES: "sparkles"
  };
  return icons[key] || "circle-check";
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
      let normalized;
      if (/\bclass\s*=\s*["']/i.test(tag)) {
        normalized = tag.replace(/(\bclass\s*=\s*["'])([^"']*)/i, (_match, start, classes) => {
          const safeClasses = classes
            .split(/\s+/)
            .filter((name) => name && name !== "rounded-full" && name !== "object-cover")
            .join(" ");
          return `${start}${safeClasses} sitesnap-brand-logo object-contain`;
        });
      } else {
        normalized = tag.replace(/^<img/i, '<img class="sitesnap-brand-logo object-contain"');
      }
      return /\bonerror\s*=/i.test(normalized)
        ? normalized
        : normalized.replace(/^<img/i, '<img onerror="this.remove()"');
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
  html = html
    .replace(/\bmin-w-85vw\b/g, "min-w-[85vw]")
    .replace(/\bfont-700\b/g, "font-bold")
    .replace(/\bcol-span-2\s+md:col-span-1\b/g, "md:col-span-1")
    .replace(/\[ICON_([A-Z0-9_]+)\]/g, (_match, token) => `<i data-lucide="${lucideIconName(token)}" aria-hidden="true"></i>`);
  if (/\bdata-lucide\s*=/i.test(html)) {
    if (!/<script\b[^>]*src=["'][^"']*lucide[^"']*["']/i.test(html)) {
      html = html.replace(/<\/head>/i, '<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script></head>');
    }
    if (!/lucide\.createIcons\s*\(/i.test(html)) {
      html = html.replace(/<\/body>/i, '<script>if(window.lucide){lucide.createIcons();}</script></body>');
    }
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
  return `You are a Senior Brand Strategist, Website Brief Writer, and UI Art Director for American local businesses.

Create a strict JSON brief for a modern, high-converting single-page website. VERIFIED_CRM is the source of truth; research is supporting context only. Never invent facts, services, testimonials, ratings, review counts, licenses, guarantees, awards, locations served, business hours, ownership claims, or unsupported outcomes.

The design must feel specific to this business rather than a repeated template. Use existing website, logo, social profiles and images as brand cues, not as a layout to copy. Choose exactly one coherent value for every design decision: DESIGN_ARCHETYPE, PALETTE_ID, BACKGROUND_MODE, NEUTRAL_FAMILY, FONT_PAIR, LAYOUT_VARIANT, HERO_STYLE, SECTION_STYLE and IMAGE_TREATMENT. Existing colors and recommended colors are different fields. Make PRIMARY_COLOR, ACCENT_COLOR, BACKGROUND_COLOR, TEXT_COLOR, RECOMMENDED_COLORS, PALETTE_ID, BACKGROUND_MODE, AVOID_COLORS and CLAUDE_DESIGN_INSTRUCTIONS agree with one another.

Choose an industry-fit direction. Cleaning/wellness/medical/beauty should usually feel bright, calm and fresh; construction/HVAC/roofing/auto strong and practical; legal/finance/real-estate stable and trusted; restaurants/retail/gyms memorable and local; landscape/floral/outdoor natural and warm. Avoid repeating black/gold luxury, full-black heroes, amber/orange CTAs, generic blue/white corporate styling and gradient-heavy SaaS looks unless clearly justified by the business.

Use only direct, useful HTTPS image URLs. Exclude search pages, tracking links, screenshots, website previews, maps, logos used as photos, avatars, icons, SVGs and tiny thumbnails. Preserve exact rating and review count in SOCIAL_PROOF_INSTRUCTIONS when supplied. Normalize a US phone for visible use without a leading +1 and make Call Now the primary CTA when a phone exists.

Return strict JSON only, no markdown, using exactly these keys:
{"BUSINESS_NAME":"","INDUSTRY":"","PHONE":"","ADDRESS":"","CITY_COUNTRY":"","MAP_URL":"","TAGLINE":"","EXISTING_COLORS":[],"RECOMMENDED_COLORS":[],"PRIMARY_COLOR":"","ACCENT_COLOR":"","BACKGROUND_COLOR":"","TEXT_COLOR":"","ABOUT_US":"","SERVICES":[],"TESTIMONIALS":[],"SOCIAL_PROOF_INSTRUCTIONS":"","visual_keywords":"","imagesArray":[],"DESIGN_ARCHETYPE":"","PALETTE_ID":"","BACKGROUND_MODE":"","NEUTRAL_FAMILY":"","FONT_PAIR":"","LAYOUT_VARIANT":"","HERO_STYLE":"","SECTION_STYLE":"","IMAGE_TREATMENT":"","EXISTING_BRAND_CUES":[],"BRAND_CUE_STRENGTH":"","BRAND_COLOR_STRATEGY":"","UPGRADE_STRATEGY":"","INDUSTRY_FIT_REASON":"","AVOID_COLORS":[],"CLAUDE_DESIGN_INSTRUCTIONS":""}`;
}

function htmlSystem() {
  return `You are an elite front-end developer, UX designer and marketing copywriter specializing in polished American local-business websites. Generate one complete, visually rich HTML landing page with Tailwind CSS CDN. It must feel custom-built for this business, not like a generic template. ORIGINAL_JSON/WEBSITE_BRIEF and VERIFIED_CRM are the only factual sources. Never invent facts, services, quotes, names, ratings, review counts, claims, guarantees, awards, licenses, certifications, hours, locations, ownership or outcomes.

OUTPUT AND SAFETY
- Return one raw document beginning <!DOCTYPE html> and ending </html>, with a viewport meta tag. No markdown, comments or explanation. Never truncate: simplify decoration and copy before omitting required content.
- Use only supplied HTTPS photo URLs. Never use screenshots, website previews, UI captures, logos, avatars, maps, icons, SVGs, data URLs or tiny thumbnails as hero/service/about photos.
- Use only tel:, mailto: and internal anchors. Never link to the old business website. Use a third-party booking/order/reservation URL only when the data clearly supplies one.
- Do not create forms, map iframes, JSON-LD or real icons. In Contact use exactly <div data-map-placeholder="true"></div> when an address exists. Leave icons as contextual [ICON_*] placeholders for QA to replace.
- Phone href values use digits only; visible US phone numbers omit +1. Important tap targets are at least 44px.

REQUIRED STRUCTURE
Wrap the required sections in these literal audit markers: <HERO_START>…<HERO_END>, <SERVICES_START>…<SERVICES_END>, <HOW_IT_WORKS_START>…<HOW_IT_WORKS_END>, <SOCIAL_PROOF_START>…<SOCIAL_PROOF_END>, <CONTACT_START>…<CONTACT_END>, <FOOTER_START>…<FOOTER_END>. Include Header, Hero, post-hero feature strip, Services, exactly-three-step Process/Journey, Social Proof/Trust, Contact and Footer. Include About/Story when ABOUT_US is meaningful.

DESIGN COMPOSITION
- Follow the supplied archetype, palette, fonts, hero, section and image-treatment fields. Respect AVOID_COLORS. Do not fall back to black/gold, dark luxury, generic blue, teal or amber/orange unless the brief supports it.
- Do not repeat centered eyebrow + centered heading + identical grid in every section. Use at least two of: asymmetrical split, overlapping card, editorial side-by-side, featured card beside smaller cards, staggered cards, left-aligned header, mixed card sizes, image collage, image with readable panel, grid-breaking accent panel.
- Use at most two distinct tasteful CSS pattern treatments, actually applied across two or three non-hero sections: restrained radial glows, dot/grid texture, layered gradients, borders or geometric accents. Patterns must remain visible without reducing contrast.
- Header is a separate, compact visual surface and may contain only business name, valid logo, short city/state, Call button and a verified external action button. No ratings, slogans, long nav, badges or trust bars. Logo is header-only, object-contain, natural aspect ratio, never circular/cropped; use text branding when invalid. Mobile shows “Call” or a phone icon, not a full number.

HERO AND COPY
- Hero is the strongest visual moment and follows the brief rather than always using a split layout. Include location/eyebrow, a specific benefit-driven H1 preferably under eight words, one-sentence subheadline, primary Call CTA and a real photo.
- Mobile Hero must contain a visible foreground photo card inside the Hero, aspect 4/3, never hidden at mobile. A background photo alone does not count. Use object-cover and readable text panel/overlay; no excessive viewport-height whitespace.
- Immediately after Hero add a compact factual strip of 3–5 short items, each 2–5 words, with small icon placeholders and no buttons, phones or unsupported claims.

SERVICES — MANDATORY LAYOUT
- Use 4 or 6 main service cards. For 4: two featured photo cards plus two compact cards. For 6: two or three featured photo cards plus compact cards; use three featured only with three strong photos. Do not insert CTA cards.
- Featured service cards use real photos, aspect 4/3, object-cover, short title and short description.
- Every compact card has exactly this visual structure: row 1 is icon + title on the same horizontal row; row 2 is a short description below the full row. Never put the icon above the title or in a separate left column beside both title and paragraph.
- On mobile the compact-card grid is two columns (grid-cols-2), descriptions are text-sm, cards are tight and avoid empty vertical space. After the service grid add a short factual highlight strip with no buttons or phone.

PROCESS, PROOF, ABOUT, CONTACT
- Process has exactly three sequential customer-focused steps and a business-appropriate title, not automatically “How It Works.” On mobile each card uses number/icon + title in one row and description below; Process must look different from Services.
- Use exact rating/review count only when supplied. Never invent or round. Use real testimonials only; never invent quotes, reviewers or initials. If none exist, use factual trust/value cards without quotation marks. Mobile testimonials use native horizontal swipe (overflow-x-auto, snap-x, cards min-width about 85vw); desktop may use a grid.
- About is concise and editorial, not another centered card grid.
- Contact is a polished closing panel with phone, address, Call CTA, exact map placeholder and hours only when supplied. No form.

MOBILE, TYPE AND MOTION
- Build mobile-first: major sections usually py-10/py-12, section headers mb-8, gaps 4 on mobile and 6–8 on desktop. Avoid oversized cards, blank vertical gaps and horizontal overflow except testimonial swipe. Normal copy is text-base; text-sm only for compact descriptions/labels; text-xs only metadata.
- Do not build an animation system, IntersectionObserver or hidden-start opacity. All content is visible by default. QA adds safe motion later.
- End with <template id="sitesnap-category-note">one factual category-specific sentence under 24 words explaining the design fit</template>.`;
}

function fallbackBriefJson(facts) {
  return JSON.stringify({
    BUSINESS_NAME: facts.businessName,
    INDUSTRY: facts.category,
    PHONE: facts.phone,
    ADDRESS: facts.address,
    CITY_COUNTRY: [facts.city, facts.state, facts.country].filter(Boolean).join(", "),
    TAGLINE: `Professional ${facts.category || "local"} services you can count on`,
    ABOUT_US: facts.about,
    SERVICES: facts.category ? [facts.category] : ["Professional Services"],
    TESTIMONIALS: [],
    PRIMARY_COLOR: "#0f766e",
    ACCENT_COLOR: "#0ea5e9",
    BACKGROUND_COLOR: "#f8fafc",
    TEXT_COLOR: "#0f172a"
  });
}

function fallbackWebsite(facts, briefJson, images) {
  const brief = JSON.parse(briefJson);
  const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(text(value)) ? text(value) : fallback;
  const primary = color(brief.PRIMARY_COLOR, "#0f766e");
  const accent = color(brief.ACCENT_COLOR, "#0ea5e9");
  const background = color(brief.BACKGROUND_COLOR, "#f8fafc");
  const phone = localUsPhone(facts.phone);
  const location = text(facts.address) || [facts.city, facts.state].filter(Boolean).join(", ");
  const approvedImages = [...new Set(images.filter((url) => /^https:\/\//i.test(url)))].slice(0, 3);
  const image = approvedImages[0] || "";
  const logo = /^https:\/\//i.test(text(facts.logo)) ? text(facts.logo) : "";
  const serviceValues = Array.isArray(brief.SERVICES) ? brief.SERVICES : [];
  const services = serviceValues.slice(0, 6).map((service) => ({
    title: typeof service === "string" ? text(service) : text(service?.name || service?.title || service?.service),
    description: typeof service === "string" ? "" : text(service?.description || service?.summary || service?.details)
  })).filter((service) => service.title);
  if (!services.length) services.push({ title: facts.category || "Professional Services", description: "" });
  const safeValueCards = [
    { title: "Helpful Local Team", description: "Call to discuss what you need and the next practical step." },
    { title: "Clear Next Steps", description: "Get the information you need before deciding how to proceed." },
    { title: "Customer-Focused Service", description: "Ask how the available services can fit your situation." }
  ];
  for (const valueCard of safeValueCards) {
    if (services.length >= 4) break;
    services.push(valueCard);
  }
  const tagline = text(brief.TAGLINE) || `Professional ${facts.category || "local"} services you can count on`;
  const about = text(brief.ABOUT_US || facts.about) || `${facts.businessName} serves customers in ${[facts.city, facts.state].filter(Boolean).join(", ") || "the local area"}.`;
  const call = phone.digits ? `<a class="button" href="tel:${escapeHtml(phone.digits)}"><i data-lucide="phone"></i><span>Call ${escapeHtml(phone.display)}</span></a>` : "";
  const compactCall = phone.digits ? `<a class="header-call" href="tel:${escapeHtml(phone.digits)}"><i data-lucide="phone"></i><span>Call</span></a>` : "";
  const email = facts.email ? `<a class="button secondary" href="mailto:${escapeHtml(facts.email)}">Email Us</a>` : "";
  const serviceDescription = (service) => service.description || `Contact ${facts.businessName} to ask about ${service.title}.`;
  const featuredCount = approvedImages.length ? Math.min(2, services.length) : 0;
  const featuredCards = services.slice(0, featuredCount).map((service, index) => `<article class="featured-service ss-reveal ${index ? "ss-from-right" : "ss-from-left"} ss-card-hover"><div class="featured-photo ss-img-hover"><img src="${escapeHtml(approvedImages[index] || approvedImages[0])}" alt="${escapeHtml(service.title)}"></div><div class="featured-copy"><div class="service-head"><span class="icon-chip"><i data-lucide="${index ? "building-2" : "sparkles"}"></i></span><h3>${escapeHtml(service.title)}</h3></div><p>${escapeHtml(serviceDescription(service))}</p></div></article>`).join("");
  const compactServices = services.slice(featuredCount);
  const compactCards = compactServices.map((service, index) => `<article class="compact-service ss-reveal ss-from-bottom ss-card-hover" style="--ss-delay:${index * 100}ms"><div class="service-head"><span class="icon-chip"><i data-lucide="${["check-circle", "shield-check", "home", "wrench"][index % 4]}"></i></span><h3>${escapeHtml(service.title)}</h3></div><p>${escapeHtml(serviceDescription(service))}</p></article>`).join("");
  const stripItems = services.slice(0, Math.min(4, services.length)).map((service) => `<div><i data-lucide="check"></i><span>${escapeHtml(service.title)}</span></div>`).join("");
  const rating = text(facts.rating);
  const reviews = text(facts.reviews);
  const proofSummary = rating
    ? `<div class="rating-line"><i data-lucide="star"></i><strong>${escapeHtml(rating)}/5</strong>${reviews ? `<span>from ${escapeHtml(reviews)} reviews</span>` : ""}</div>`
    : `<div class="rating-line"><i data-lucide="map-pin"></i><strong>${escapeHtml(location || facts.businessName)}</strong></div>`;
  const map = location ? `<iframe data-sitesnap-map title="Map for ${escapeHtml(facts.businessName)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://www.google.com/maps?q=${encodeURIComponent(location)}&output=embed"></iframe>` : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(facts.businessName)}</title><script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script><style>
:root{--primary:${primary};--accent:${accent};--bg:${background};--ink:#0f172a;--muted:#475569;--line:#dbe3ea}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--ink);background:var(--bg);font:16px/1.62 Inter,Arial,sans-serif}a{color:inherit}img{display:block;max-width:100%}header>div,section>div,footer>div{width:min(1120px,calc(100% - 40px));margin:auto}.site-header{position:relative;z-index:20;background:#fff;color:var(--ink);border-bottom:1px solid var(--line);box-shadow:0 8px 24px rgba(15,23,42,.08)}.nav{min-height:76px;display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{display:flex;min-width:0;align-items:center;gap:13px;font-size:20px;font-weight:900;text-decoration:none}.brand img{width:auto;max-width:180px;height:52px;object-fit:contain;border-radius:0}.brand-text{min-width:0}.brand-text small{display:block;color:var(--muted);font-size:12px;font-weight:700}.header-call{display:inline-flex;min-height:44px;align-items:center;gap:8px;padding:10px 17px;border-radius:999px;background:var(--primary);color:#fff;text-decoration:none;font-weight:900}.header-call svg,.button svg{width:19px;height:19px}.hero{position:relative;isolation:isolate;overflow:hidden;background:linear-gradient(135deg,var(--primary),#082f49);color:#fff}.hero:after{content:"";position:absolute;inset:0;z-index:-1;background:radial-gradient(circle at 86% 12%,rgba(255,255,255,.22),transparent 34%),radial-gradient(circle at 8% 90%,rgba(255,255,255,.13),transparent 34%)}.hero-grid{display:grid;grid-template-columns:1.05fr .95fr;align-items:center;gap:52px;padding:70px 0}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font-size:13px;font-weight:900;color:#d9f4ff}.hero h1{font-size:clamp(40px,6vw,72px);line-height:1.03;margin:12px 0 22px}.hero p{font-size:clamp(17px,2vw,20px);max-width:640px;color:#edf6fa}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:12px 22px;border-radius:999px;background:var(--accent);color:#fff;text-decoration:none;font-weight:900}.button.secondary{background:transparent;border:2px solid currentColor}.hero-photo{overflow:hidden;border-radius:28px;box-shadow:0 28px 70px rgba(0,0,0,.28);aspect-ratio:4/3}.hero-photo img{width:100%;height:100%;object-fit:cover;animation:ssHeroZoom 10s ease-in-out infinite alternate}.feature-strip{background:#fff;border-bottom:1px solid var(--line)}.feature-strip>div{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;padding:16px 0}.feature-strip div div{display:flex;align-items:center;justify-content:center;gap:8px;min-width:0;font-size:14px;font-weight:850}.feature-strip svg{width:17px;color:var(--accent);flex:0 0 auto}.services{padding:76px 0;background-color:var(--bg);background-image:radial-gradient(color-mix(in srgb,var(--primary) 18%,transparent) 1.2px,transparent 1.2px);background-size:24px 24px}.section-title{max-width:740px;margin-bottom:32px}.section-title h2{font-size:clamp(32px,5vw,50px);line-height:1.08;margin:8px 0}.section-title p{color:var(--muted);font-size:18px}.featured-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-bottom:18px}.featured-service,.compact-service{overflow:hidden;background:#fff;border:1px solid var(--line);border-radius:22px;box-shadow:0 14px 36px rgba(15,23,42,.08)}.featured-photo{overflow:hidden;aspect-ratio:4/3}.featured-photo img{width:100%;height:100%;object-fit:cover}.featured-copy{padding:22px}.service-head,.step-head{display:flex;align-items:center;gap:11px;min-width:0}.service-head h3,.step-head h3{margin:0;font-size:21px;line-height:1.2}.icon-chip,.step-number{display:inline-flex;width:38px;height:38px;flex:0 0 38px;align-items:center;justify-content:center;border-radius:12px;background:color-mix(in srgb,var(--accent) 16%,white);color:var(--primary)}.icon-chip svg{width:20px;height:20px}.featured-copy p,.compact-service p,.step p{margin:12px 0 0;color:var(--muted)}.compact-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.compact-service{padding:20px}.service-highlights{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}.service-highlights span{padding:8px 12px;border-radius:999px;background:#fff;border:1px solid var(--line);font-size:14px;font-weight:800}.process{padding:76px 0;background:radial-gradient(circle at 100% 0%,color-mix(in srgb,var(--accent) 18%,transparent),transparent 40%),#fff}.process-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.step{padding:23px;border:1px solid var(--line);border-radius:4px 22px 4px 22px;background:rgba(255,255,255,.86)}.step-number{background:var(--primary);color:#fff;font-weight:950}.proof{padding:76px 0;background:linear-gradient(135deg,color-mix(in srgb,var(--primary) 12%,white),color-mix(in srgb,var(--accent) 10%,white))}.proof-panel{display:grid;grid-template-columns:.8fr 1.2fr;gap:36px;align-items:center;padding:32px;border:1px solid rgba(15,23,42,.1);border-radius:26px;background:rgba(255,255,255,.84);box-shadow:0 18px 48px rgba(15,23,42,.1)}.rating-line{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:18px}.rating-line svg{color:var(--accent);fill:currentColor}.rating-line strong{font-size:30px}.proof-points{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.proof-points div{display:flex;align-items:center;gap:10px;padding:14px;border-radius:16px;background:#fff;font-weight:800}.proof-points svg{color:var(--primary)}.about{padding:76px 0;background:#fff}.about-grid,.contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:54px;align-items:center}.about h2,.contact h2{font-size:clamp(32px,5vw,50px);line-height:1.1;margin:8px 0 18px}.fact{border-left:5px solid var(--accent);padding:20px 22px;background:var(--bg);border-radius:0 18px 18px 0}.contact{padding:76px 0;background:linear-gradient(135deg,#e0f2fe,#f8fafc)}.contact iframe{display:block;width:100%;height:390px;border:0;border-radius:24px;box-shadow:0 18px 45px rgba(15,23,42,.14)}footer{background:#062f26;color:#dbe7e2;padding:44px 0}footer h2{color:#fff;margin:0 0 8px}.footer-row{display:flex;justify-content:space-between;gap:30px;align-items:flex-start}.ss-card-hover{transition:transform 350ms ease,box-shadow 350ms ease}.ss-card-hover:hover{transform:translateY(-4px);box-shadow:0 16px 40px rgba(0,0,0,.12)}.ss-img-hover img{transition:transform 500ms ease}.ss-img-hover:hover img{transform:scale(1.04)}.ss-reveal{opacity:1;transform:none}body.ss-motion-ready .ss-reveal{opacity:0;transition:opacity 1100ms cubic-bezier(.22,1,.36,1),transform 1100ms cubic-bezier(.22,1,.36,1);transition-delay:var(--ss-delay,0ms)}body.ss-motion-ready .ss-from-left{transform:translateX(-48px)}body.ss-motion-ready .ss-from-right{transform:translateX(48px)}body.ss-motion-ready .ss-from-bottom{transform:translateY(38px)}body.ss-motion-ready .ss-visible{opacity:1;transform:none}@keyframes ssHeroZoom{from{transform:scale(1)}to{transform:scale(1.055)}}
@media(max-width:760px){header>div,section>div,footer>div{width:min(100% - 32px,1120px)}.nav{min-height:66px}.brand img{height:44px;max-width:145px}.brand-text small{display:none}.hero-grid,.about-grid,.contact-grid,.proof-panel{grid-template-columns:1fr}.hero-grid{padding:46px 0;gap:28px}.hero h1{font-size:clamp(38px,12vw,52px)}.hero-photo{width:100%;aspect-ratio:4/3}.feature-strip>div{grid-template-columns:repeat(2,minmax(0,1fr));padding:14px 0}.feature-strip div div{justify-content:flex-start}.services,.process,.proof,.about,.contact{padding:48px 0}.section-title{margin-bottom:28px}.featured-grid{grid-template-columns:1fr}.compact-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.compact-service{padding:14px}.compact-service .service-head{gap:8px}.compact-service .icon-chip{width:32px;height:32px;flex-basis:32px}.compact-service .service-head h3{font-size:16px}.compact-service p{font-size:14px;line-height:1.45}.process-grid{grid-template-columns:1fr}.step{padding:18px}.proof-points{grid-template-columns:1fr}.footer-row{flex-direction:column}.contact iframe{height:320px}}@media(max-width:390px){.brand-text span{font-size:17px}.compact-grid{gap:8px}.compact-service{padding:12px}.compact-service .service-head h3{font-size:15px}.compact-service p{font-size:13px}.actions{align-items:stretch}.actions .button{width:100%}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.hero-photo img{animation:none!important}.ss-card-hover,.ss-img-hover img,.ss-reveal{transition:none!important}body.ss-motion-ready .ss-reveal{opacity:1!important;transform:none!important}}
</style></head><body><header class="site-header"><div class="nav">${logo ? `<a class="brand" href="#top"><img src="${escapeHtml(logo)}" alt="${escapeHtml(facts.businessName)} logo" onerror="this.remove()"><span class="brand-text"><span>${escapeHtml(facts.businessName)}</span>${location ? `<small>${escapeHtml([facts.city, facts.state].filter(Boolean).join(", ") || location)}</small>` : ""}</span></a>` : `<a class="brand" href="#top"><span class="brand-text"><span>${escapeHtml(facts.businessName)}</span>${location ? `<small>${escapeHtml([facts.city, facts.state].filter(Boolean).join(", ") || location)}</small>` : ""}</span></a>`}${compactCall}</div></header><main id="top"><section class="hero"><div class="hero-grid"><div><div class="eyebrow">${escapeHtml([facts.city, facts.state].filter(Boolean).join(", ") || facts.category || "Local business")}</div><h1>${escapeHtml(tagline)}</h1><p>${escapeHtml(about)}</p><div class="actions">${call}${email}</div></div>${image ? `<div class="hero-photo"><img src="${escapeHtml(image)}" alt="${escapeHtml(facts.category || facts.businessName)}"></div>` : ""}</div></section><section class="feature-strip"><div>${stripItems}</div></section><section id="services" class="services"><div><div class="section-title"><div class="eyebrow" style="color:var(--primary)">Services</div><h2>Practical help for what comes next</h2><p>Explore the services and contact ${escapeHtml(facts.businessName)} for details that match your needs.</p></div>${featuredCards ? `<div class="featured-grid">${featuredCards}</div>` : ""}<div class="compact-grid">${compactCards || services.map((service, index) => `<article class="compact-service ss-card-hover"><div class="service-head"><span class="icon-chip"><i data-lucide="check-circle"></i></span><h3>${escapeHtml(service.title)}</h3></div><p>${escapeHtml(serviceDescription(service))}</p></article>`).join("")}</div><div class="service-highlights">${services.slice(0,4).map((service)=>`<span>${escapeHtml(service.title)}</span>`).join("")}</div></div></section><section id="process" class="process"><div><div class="section-title"><div class="eyebrow" style="color:var(--primary)">A simple start</div><h2>From question to next step</h2></div><div class="process-grid"><article class="step ss-reveal ss-from-bottom"><div class="step-head"><span class="step-number">1</span><h3>Get in touch</h3></div><p>Call or email with the service you are interested in.</p></article><article class="step ss-reveal ss-from-bottom" style="--ss-delay:100ms"><div class="step-head"><span class="step-number">2</span><h3>Share your needs</h3></div><p>Provide the details that help the team understand your request.</p></article><article class="step ss-reveal ss-from-bottom" style="--ss-delay:200ms"><div class="step-head"><span class="step-number">3</span><h3>Choose the next step</h3></div><p>Discuss the available service and how to move forward.</p></article></div></div></section><section id="reviews" class="proof"><div><div class="proof-panel ss-reveal ss-from-bottom"><div><div class="eyebrow" style="color:var(--primary)">Local confidence</div><h2>Clear information before you call</h2>${proofSummary}</div><div class="proof-points"><div><i data-lucide="phone"></i><span>Easy to contact</span></div>${location ? `<div><i data-lucide="map-pin"></i><span>${escapeHtml([facts.city, facts.state].filter(Boolean).join(", ") || "Local location")}</span></div>` : ""}<div><i data-lucide="list-checks"></i><span>Service options</span></div><div><i data-lucide="message-circle"></i><span>Clear next step</span></div></div></div></div></section><section id="about" class="about"><div class="about-grid"><div><div class="eyebrow" style="color:var(--primary)">About</div><h2>${escapeHtml(facts.businessName)}</h2><p>${escapeHtml(about)}</p></div><div class="fact"><strong>${escapeHtml(facts.businessName)}</strong><br>${escapeHtml(location || facts.category || "Local business")}</div></div></section><section id="contact" class="contact"><div class="contact-grid"><div><div class="eyebrow" style="color:var(--primary)">Contact</div><h2>Ready to start a conversation?</h2>${location ? `<p>${escapeHtml(location)}</p>` : ""}<div class="actions">${call}${email}</div></div>${map}</div></section></main><footer><div class="footer-row"><div><h2>${escapeHtml(facts.businessName)}</h2><div>${escapeHtml(facts.category || "Local service")}</div></div><div>${phone.display ? `<a href="tel:${escapeHtml(phone.digits)}">${escapeHtml(phone.display)}</a>` : ""}${facts.email ? `<br><a href="mailto:${escapeHtml(facts.email)}">${escapeHtml(facts.email)}</a>` : ""}</div></div></footer><template id="sitesnap-category-note">The layout balances clear service choices, local trust and mobile-friendly contact for ${escapeHtml(facts.category || "this local business")} customers.</template><script>lucide.createIcons();</script><script>(function(){try{var items=document.querySelectorAll('.ss-reveal');if(!items.length)return;document.body.classList.add('ss-motion-ready');if(!('IntersectionObserver' in window)){items.forEach(function(el){el.classList.add('ss-visible')});return}var observer=new IntersectionObserver(function(entries){entries.forEach(function(entry){if(entry.isIntersecting){entry.target.classList.add('ss-visible');observer.unobserve(entry.target)}})},{threshold:.16,rootMargin:'0px 0px -8% 0px'});items.forEach(function(el){observer.observe(el)})}catch(e){document.querySelectorAll('.ss-reveal').forEach(function(el){el.classList.add('ss-visible')});document.body.classList.remove('ss-motion-ready')}})();</script></body></html>`;
}

function auditSystem() {
  return `You are a senior HTML QA engineer and front-end finalizer. Claude is the main designer. Perform a minimal, precise repair and enhancement pass: preserve complete sections, creative direction, palette, typography, layout rhythm, order and tone. Do not redesign, simplify, shorten or replace good sections. If HTML is incomplete, finish it in the existing style. Return only one raw document beginning <!DOCTYPE html> and ending </html>.

Use WEBSITE_BRIEF/ORIGINAL_JSON as source of truth and VERIFIED_CRM only as fallback. Remove or soften unsupported facts, claims, services, testimonials, names, initials, ratings, counts, guarantees, awards, licenses, hours and locations. Remove generic placeholders and all visible audit markers. Keep only supplied safe HTTPS photos; never use logos, screenshots, maps, avatars, UI captures, SVGs or thumbnails as content photos.

Repair structure, unclosed tags/quotes, invalid links, contrast, accessibility and mobile overflow. Remove every form. Phone links must use the verified digits; visible US numbers omit +1. Never link to the old business website. Preserve only verified third-party action URLs. Insert a real Google Maps embed when an address exists, in a parent with real mobile/desktop height; otherwise remove the placeholder.

Use a valid logo in the header only, object-contain, uncropped and non-circular. Header must be a separate readable surface; mobile header shows Call/icon rather than the full number. Hero must keep a visible mobile foreground photo card with a 4:3 crop. Tap targets are at least 44px.

SERVICES MOBILE QA IS MANDATORY: preserve 4-or-6 service composition with featured photo cards. For every compact service card, row 1 must be icon + title on the same horizontal row and row 2 the description below the whole row. Compact cards must render two per row on mobile, with short text-sm descriptions and no tall empty spacing. Process has exactly three steps and uses the same number/icon + title row rule on mobile while remaining visually distinct from Services. Testimonials use native horizontal swipe on mobile and desktop grid when real testimonials exist.

Replace every [ICON_*] placeholder with an appropriate Lucide <i data-lucide="…"> icon. Add the Lucide CDN once and lucide.createIcons() once. Remove empty icon circles.

Preserve valid images and photo-card layout. Use object-top for people and object-center for rooms/products/equipment. Ensure at least two or three non-hero sections visibly use no more than two tasteful background-depth treatments (radial glow, layered gradient, restrained dot/grid, border/texture) without hurting readability.

Use exact source testimonials/ratings only. When quotes do not exist, use factual trust/value cards without quotes or invented people. Add one valid FAQPage JSON-LD script in head with 3–4 factual questions only; no visible FAQ. Keep one hidden <template id="sitesnap-category-note"> sentence under 24 words before body closes.

Add the SiteSnap motion system once as progressive enhancement: hero zoom 8–12s, card/image hover 300–500ms, and scroll reveals 900–1400ms for featured services, compact services and at least one other section. Content must remain visible if JS fails; add body.ss-motion-ready only inside guarded JS, support prefers-reduced-motion, and avoid duplicate CSS/JS. Do not add the SiteSnap floating button, modal, final banner, tracker or wrapper comments; those are injected later.

Final verification: all required sections survive; compact service and process mobile rows are correct; no form or old-site links remain; map/logo/images/phones are valid; FAQ JSON-LD and category note appear once; motion is fail-safe; HTML is complete.`;
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
  const anchorNavigation = `<script data-sitesnap-anchor-nav>(function(){document.addEventListener("click",function(event){var link=event.target.closest&&event.target.closest('a[href^="#"]');if(!link)return;var id=link.getAttribute("href").slice(1),target=document.getElementById(id);if(!target)return;event.preventDefault();target.scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"start"});history.replaceState(null,"","#"+id)})})();</script>`;
  const legacyBlock = `<style data-sitesnap-preview>.sitesnap-preview-cta{position:fixed;right:20px;bottom:20px;z-index:9999;background:#0070f3;color:#fff;border-radius:999px;padding:13px 20px;text-decoration:none;font:800 14px/1.2 Inter,system-ui,sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.28)}.sitesnap-preview-note{max-width:900px;margin:0 auto;padding:28px 20px;color:#334155;font:500 14px/1.6 Inter,system-ui,sans-serif}</style>
${contact}
<div class="sitesnap-preview-note" data-sitesnap-design-note>${escapeHtml(category)}</div>
<a class="sitesnap-preview-cta" href="https://trysitesnap.com/finalize?record_id=${encodeURIComponent(recordId)}" target="_blank" rel="noopener noreferrer">Personalize This Sketch →</a>
${tracker}
${anchorNavigation}`;
  void legacyBlock;
  const finalizeUrl = `https://trysitesnap.com/finalize?record_id=${encodeURIComponent(recordId)}&business_name=${encodeURIComponent(facts.businessName)}`;
  const block = `<style data-sitesnap-preview>
html,body{max-width:100%;overflow-x:hidden}
.sitesnap-brand-logo{object-fit:contain!important;border-radius:8px!important;background:rgba(255,255,255,.96)!important;padding:4px!important;filter:drop-shadow(0 1px 2px rgba(15,23,42,.2))}
.sitesnap-brand-header{background:#f8fafc!important;color:#0f172a!important;border-bottom:1px solid #cbd5e1!important;box-shadow:0 8px 24px rgba(15,23,42,.12)!important}
.sitesnap-brand-header>div>:first-child,.sitesnap-brand-header>div>:first-child *{color:#0f172a!important}.sitesnap-brand-header>div>:first-child [class*="text-red"]{color:#b91c1c!important}
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
${tracker}
${anchorNavigation}`;
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
    const draftUrl = /^https?:\/\//i.test(existingDraft) ? existingDraft : `https://${existingDraft}`;
    const businessName = text(jobFields["Business Name"], "Customer");
    const emailRedirected = Boolean(options.redirectEmail);
    const recipient = emailRedirected ? config.firstSketch.testRecipient : text(jobFields["Customer Email"]);
    if (options.retryEmail) {
      if (!recipient) {
        const error = new Error("No email recipient is available for the retry");
        error.code = "SCENARIO_04_EMAIL_RETRY_MISSING_RECIPIENT";
        error.stage = "email_retry";
        throw error;
      }
      await runStage("email_retry", timings, () => mail.send({
        to: recipient,
        ...sketchEmail({ businessName, url: draftUrl, recordId: id, testMode: emailRedirected })
      }));
      return {
        success: true,
        recoveredEmail: true,
        testMode: false,
        recordId: id,
        businessName,
        recipient,
        emailRedirected,
        draftUrl,
        airtableUpdated: false,
        notificationSent: false,
        timings
      };
    }
    return {
      success: true,
      duplicate: true,
      testMode: false,
      recordId: id,
      businessName,
      recipient,
      emailRedirected: false,
      draftUrl,
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

  const [researchResult, stockResult] = await runStage("research", timings, () => Promise.allSettled([
    tavily.search(`Official website, portfolio, customer reviews and professional assets for ${facts.businessName} (${facts.category}) in ${facts.address || `${facts.city}, ${facts.state}`}. Prefer official sources and direct image links.`),
    pexels.search([facts.category, facts.city, facts.state].filter(Boolean).join(", "), (id.charCodeAt(id.length - 1) % 8) + 1)
  ]));
  const research = researchResult.status === "fulfilled" ? researchResult.value : { results: [], images: [] };
  const stock = stockResult.status === "fulfilled" ? stockResult.value : { photos: [] };
  const researchFallbackUsed = researchResult.status === "rejected" || stockResult.status === "rejected";
  let briefFallbackUsed = false;
  let brief;
  try {
    brief = await runStage("brief", timings, async () => safeJson(await sketchBrief.generate({
      system: briefSystem(),
      user: `VERIFIED_CRM:\n${JSON.stringify(siteFacts)}\n\nRESEARCH:\n${researchText(research)}\n\nCreate the strict website brief.`,
      maxTokens: 4096,
      temperature: 0.3,
      json: true
    })));
  } catch {
    briefFallbackUsed = true;
    brief = fallbackBriefJson(siteFacts);
  }
  const images = [...new Set([...pexelsImages(stock), ...(research.images || [])])].filter((url) => /^https:\/\//i.test(url)).slice(0, 30);
  let htmlProviderFailed = false;
  let claudeOutput = "";
  try {
    claudeOutput = stripHtml(await runStage("html", timings, () => sketchHtml.generate({
      system: htmlSystem(),
      user: `ORIGINAL_JSON / WEBSITE_BRIEF:\n${brief}\n\nVERIFIED_CRM:\n${JSON.stringify(siteFacts)}\n\nPEXELS_IMAGES_AND_BUSINESS_RESEARCH_IMAGES:\n${JSON.stringify(images)}\n\nGenerate the complete website and preserve every required section and mobile rule. If length becomes a concern, shorten copy and decorative details before omitting any required structure. Finish the document through </html>.`,
      maxTokens: 10000,
      temperature: 0.4
    })));
  } catch {
    htmlProviderFailed = true;
  }
  let geminiOutput = claudeOutput;
  let structureError = htmlStructureError(geminiOutput);
  let auditUsed = false;
  let fallbackUsed = false;
  let repairProviderFailed = false;
  if (!htmlProviderFailed && claudeOutput) {
    auditUsed = true;
    try {
      const auditedOutput = stripHtml(await runStage("html_audit", timings, () => sketchAudit.generate({
        system: auditSystem(),
        user: `CLAUDE_HTML:\n${claudeOutput}\n\nORIGINAL_JSON / WEBSITE_BRIEF:\n${brief}\n\nVERIFIED_CRM:\n${JSON.stringify(siteFacts)}\n\nPEXELS_ARRAY_AND_BUSINESS_PICS:\n${JSON.stringify(images)}\n\nPerform the full minimal QA pass. The source structure status is: ${structureError || "complete"}. Preserve the design, repair every listed desktop/mobile requirement, and return the complete final HTML through </html>.`,
        maxTokens: 10000,
        temperature: 0.1
      })));
      const auditStructureError = htmlStructureError(auditedOutput);
      if (!auditStructureError) {
        geminiOutput = auditedOutput;
        structureError = "";
      } else if (!structureError) {
        geminiOutput = claudeOutput;
        structureError = "";
      } else {
        geminiOutput = auditedOutput;
        structureError = auditStructureError;
      }
    } catch {
      repairProviderFailed = true;
      geminiOutput = claudeOutput;
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
    researchFallbackUsed,
    briefFallbackUsed,
    htmlProviderFailed,
    repairProviderFailed,
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
