import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isValidLeadEmail } from "./email-export.js";
import { validateEmailLocally } from "./overture-leads.js";

const GOOD_VERIFICATION = new Set(["GOOD", "OK"]);
const CONTACT_HINT = /(?:contact|about|team|staff|privacy|legal|support|reach[-_ ]?us|get[-_ ]?in[-_ ]?touch)/i;
const SOCIAL_HOSTS = /(?:^|\.)(?:facebook|instagram|linkedin|tiktok|x|twitter|yelp)\.com$/i;
const FREE_MAIL_HOSTS = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "aol.com", "icloud.com"]);
const JUNK_EMAIL_HOSTS = new Set(["example.com", "example.org", "domain.com", "email.com", "sentry.io"]);
const JUNK_LOCAL_PARTS = /^(?:example|yourname|name|email|test|noreply|no-reply|donotreply|do-not-reply)$/i;
const ROLE_LOCAL_PART = /^(?:admin|booking|careers?|contact|customerservice|events?|frontdesk|general|hello|info|inquiries?|marketing|office|reception|reservations?|sales|service|support|team)(?:[._+-]|$)/i;
const BUSINESS_STOP_WORDS = new Set([
  "and", "company", "co", "corp", "corporation", "fl", "florida", "group", "inc", "llc", "of", "restaurant",
  "real", "estate", "service", "services", "salon", "spa", "the", "agency", "center", "centre"
]);
const NON_PAGE_EXTENSIONS = /\.(?:avif|bmp|css|csv|docx?|gif|ico|jpe?g|js|json|mp3|mp4|pdf|png|pptx?|svg|webp|xlsx?|xml|zip)(?:$|[?#])/i;
const EMAIL_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;
const MAX_HTML_BYTES = 1_000_000;

function text(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function parseJson(value, fallback) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(text(value));
  } catch {
    return fallback;
  }
}

function decodeHtml(value) {
  return text(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&commat;|&#64;|&commat/gi, "@")
    .replace(/&period;|&#46;|&period/gi, ".")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function normalizeEmail(value) {
  return lower(decodeURIComponentSafe(value)).replace(/^mailto:/, "").split(/[?;,\s]/)[0];
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(text(value));
  } catch {
    return text(value);
  }
}

function usableEmail(email) {
  if (!isValidLeadEmail(email)) return false;
  const [local, host] = email.split("@");
  if (JUNK_LOCAL_PARTS.test(local) || JUNK_EMAIL_HOSTS.has(host)) return false;
  if (/\.(?:png|jpe?g|gif|svg|webp|invalid|local)$/i.test(host)) return false;
  return true;
}

function unique(values) {
  return [...new Set(values.map(normalizeEmail).filter(usableEmail))];
}

function visibleHtml(html) {
  return decodeHtml(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

export function extractVisibleEmails(html) {
  const decoded = decodeHtml(html);
  const mailto = [...decoded.matchAll(/href\s*=\s*["']mailto:([^"'#?\s>]+)[^"']*["']/gi)].map((match) => match[1]);
  const plain = visibleHtml(decoded).match(EMAIL_PATTERN) || [];
  const obfuscated = [];
  const markedAtPattern = /\b([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)\s*(?:\[\s*at\s*\]|\(\s*at\s*\))\s*([a-z0-9-]+(?:\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\s+dot\s+|\.)\s*[a-z0-9-]+)+)/gi;
  for (const match of visibleHtml(decoded).matchAll(markedAtPattern)) {
    const domain = match[2].replace(/\s*(?:\[|\()?\s*dot\s*(?:\]|\))?\s*/gi, ".").replace(/\s+/g, "");
    obfuscated.push(`${match[1]}@${domain}`);
  }
  const textualAtPattern = /\b([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)\s+at\s+([a-z0-9-]+(?:\s+dot\s+[a-z0-9-]+)+)\b/gi;
  for (const match of visibleHtml(decoded).matchAll(textualAtPattern)) {
    if (!ROLE_LOCAL_PART.test(match[1])) continue;
    obfuscated.push(`${match[1]}@${match[2].replace(/\s+dot\s+/gi, ".")}`);
  }
  return unique([...mailto, ...plain, ...obfuscated]);
}

function identityWords(value) {
  return lower(value).replace(/[^a-z0-9]+/g, " ").split(/\s+/)
    .filter((word) => word.length >= 3 && !BUSINESS_STOP_WORDS.has(word));
}

function emailLinkedToBusiness(email, record, sourceUrl, sourceType, sourceHtml, website) {
  if (sourceType === "overture") return true;
  const fields = record.fields || {};
  const businessWords = identityWords(fields["Business Name"]);
  const localPart = email.split("@")[0].replace(/[^a-z0-9]+/g, "");
  const emailHost = email.split("@")[1];
  const domainLinked = sameSite(`https://${emailHost}`, sourceUrl) || sameSite(`https://${emailHost}`, website);
  if (domainLinked && ROLE_LOCAL_PART.test(email.split("@")[0]) && businessWords.length <= 2) return true;
  const localLinked = businessWords.some((word) => word.length >= 4 && localPart.includes(word));
  if (localLinked) return true;
  const pageWords = new Set(identityWords(visibleHtml(sourceHtml)));
  const matchedWords = businessWords.filter((word) => pageWords.has(word));
  return businessWords.length > 0 && matchedWords.length === businessWords.length;
}

function collectJsonEmails(value, output) {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonEmails(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (/email/i.test(key)) {
      const values = Array.isArray(item) ? item : [item];
      for (const candidate of values) {
        if (typeof candidate === "string") output.push(candidate);
        else if (candidate && typeof candidate === "object") collectJsonEmails(candidate, output);
      }
    } else {
      collectJsonEmails(item, output);
    }
  }
}

export function extractStructuredEmails(html) {
  const emails = [];
  for (const match of text(html).matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      collectJsonEmails(JSON.parse(decodeHtml(match[1])), emails);
    } catch {}
  }
  return unique(emails);
}

function normalizedUrl(value, base) {
  const raw = text(value);
  if (!raw || /^(?:mailto|tel|javascript|data):/i.test(raw)) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(raw) || base ? raw : `https://${raw}`, base);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || !["", "80", "443"].includes(url.port)) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function hostname(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function sameSite(left, right) {
  const a = hostname(left);
  const b = hostname(right);
  return Boolean(a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));
}

function urlsInValue(value, output = []) {
  if (typeof value === "string") {
    output.push(...(value.match(/https?:\/\/[^\s"'<>\\]+/gi) || []));
  } else if (Array.isArray(value)) {
    for (const item of value) urlsInValue(item, output);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) urlsInValue(item, output);
  }
  return output;
}

function pageLinks(html, base) {
  const links = [];
  for (const match of text(html).matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = normalizedUrl(decodeHtml(match[1]), base);
    if (!url || NON_PAGE_EXTENSIONS.test(url)) continue;
    links.push({ url, label: visibleHtml(match[2]).slice(0, 160) });
  }
  return links;
}

function privateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 0 && parts[2] === 0)
    || (parts[0] === 192 && parts[1] === 0 && parts[2] === 2)
    || (parts[0] === 192 && parts[1] === 88 && parts[2] === 99)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 198 && [18, 19].includes(parts[1]))
    || (parts[0] === 198 && parts[1] === 51 && parts[2] === 100)
    || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113);
}

function privateIp(address) {
  const version = isIP(address);
  if (version === 4) return privateIpv4(address);
  if (version !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return privateIpv4(normalized.slice(7));
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") || normalized.startsWith("2001:db8:");
}

async function assertPublicUrl(value, options = {}) {
  const url = normalizedUrl(value);
  if (!url) throw new Error("UNSAFE_URL");
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("UNSAFE_HOST");
  const addresses = isIP(host)
    ? [{ address: host }]
    : await (options.resolveHost || lookup)(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => privateIp(entry.address))) throw new Error("UNSAFE_HOST");
  return url;
}

export async function fetchPublicPage(value, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  let url = await assertPublicUrl(value, options);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetchImpl(url, {
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.7",
        "User-Agent": "SiteSnap lead research (+https://trysitesnap.com)"
      },
      signal: AbortSignal.timeout(Math.max(1000, Number(options.timeoutMs) || 5000))
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers?.get?.("location");
      if (!location || redirect === 3) throw new Error("REDIRECT_REJECTED");
      url = await assertPublicUrl(new URL(location, url).toString(), options);
      continue;
    }
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const contentType = lower(response.headers?.get?.("content-type"));
    if (contentType && !/(?:text\/html|application\/xhtml\+xml|text\/plain)/.test(contentType)) throw new Error("UNSUPPORTED_CONTENT");
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_HTML_BYTES * 2) throw new Error("CONTENT_TOO_LARGE");
    const reader = response.body?.getReader?.();
    if (!reader) {
      const body = await response.text();
      return { url, html: body.slice(0, MAX_HTML_BYTES), truncated: body.length > MAX_HTML_BYTES };
    }
    const decoder = new TextDecoder();
    let body = "";
    let bytes = 0;
    let truncated = false;
    while (bytes <= MAX_HTML_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      body += decoder.decode(chunk.value, { stream: true });
      if (bytes > MAX_HTML_BYTES) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    body += decoder.decode();
    return { url, html: body.slice(0, MAX_HTML_BYTES), truncated };
  }
  throw new Error("REDIRECT_REJECTED");
}

function orderedEmails(emails, website) {
  const siteHost = hostname(website);
  return unique(emails).sort((left, right) => {
    const leftHost = left.split("@")[1];
    const rightHost = right.split("@")[1];
    const leftScore = (siteHost && sameSite(`https://${leftHost}`, `https://${siteHost}`) ? 20 : 0) - (FREE_MAIL_HOSTS.has(leftHost) ? 2 : 0);
    const rightScore = (siteHost && sameSite(`https://${rightHost}`, `https://${siteHost}`) ? 20 : 0) - (FREE_MAIL_HOSTS.has(rightHost) ? 2 : 0);
    return rightScore - leftScore;
  });
}

function checkedRecently(fields, now, maxAgeDays) {
  const checkedAt = Date.parse(text(fields["Email Enrichment Checked At"]));
  return Number.isFinite(checkedAt) && now.getTime() - checkedAt < maxAgeDays * 86_400_000;
}

export function selectEnrichmentCandidates(records, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const limit = Math.max(1, Math.min(25, Number(options.limit) || 15));
  return (records || [])
    .filter((record) => lower(record.fields?.["Source System"]) === "overture")
    .filter((record) => lower(record.fields?.["Lead Status"]) === "candidate" || lower(record.fields?.["Lead Decision"]) === "pending_enrichment")
    .filter((record) => {
      const status = lower(record.fields?.["Email Enrichment Status"]);
      if (["found", "not_found", "duplicate_email"].includes(status) && checkedRecently(record.fields || {}, now, 30)) return false;
      if (status === "error" && checkedRecently(record.fields || {}, now, 1)) return false;
      return true;
    })
    .slice(0, limit);
}

export function reusableExternalVerification(fields, email, options = {}) {
  if (lower(fields.Email) !== lower(email)) return null;
  const status = text(fields["Email Validation Status"]).toUpperCase().replace(/[ -]+/g, "_");
  const provider = text(fields["Email Validation Provider"]);
  const checkedAt = Date.parse(text(fields["Email Validation Checked At"]));
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (!GOOD_VERIFICATION.has(status) || !provider || !Number.isFinite(checkedAt)) return null;
  if (now.getTime() - checkedAt > 30 * 86_400_000) return null;
  if (["yes", "true", "1"].includes(lower(fields["Email Catch All"]))) return null;
  if (["yes", "true", "1"].includes(lower(fields["Email Disposable"]))) return null;
  if (["yes", "true", "1"].includes(lower(fields["Email Risky"]))) return null;
  return { status, provider, checkedAt: new Date(checkedAt).toISOString() };
}

async function inspectRecord(record, context, options = {}) {
  const fields = record.fields || {};
  const website = normalizedUrl(fields.Website);
  const evidence = { version: 1, recordId: record.id, business: text(fields["Business Name"]), tried: [], candidates: [] };
  let duplicateFound = false;

  const tryEmails = async (emails, sourceUrl, sourceType, sourceHtml = "") => {
    for (const email of orderedEmails(emails, website)) {
      if (!emailLinkedToBusiness(email, record, sourceUrl, sourceType, sourceHtml, website)) {
        evidence.candidates.push({ email, sourceUrl, sourceType, outcome: "not_business_linked" });
        continue;
      }
      const priorOwner = context.emailOwners.get(email);
      if (priorOwner && priorOwner !== record.id) {
        duplicateFound = true;
        evidence.candidates.push({ email, sourceUrl, sourceType, outcome: "duplicate" });
        continue;
      }
      const check = await validateEmailLocally(email, options.dns);
      if (!check.valid) {
        evidence.candidates.push({ email, sourceUrl, sourceType, outcome: lower(check.reason) });
        continue;
      }
      const ownerAfterDns = context.emailOwners.get(email);
      if (ownerAfterDns && ownerAfterDns !== record.id) {
        duplicateFound = true;
        evidence.candidates.push({ email, sourceUrl, sourceType, outcome: "duplicate" });
        continue;
      }
      context.emailOwners.set(email, record.id);
      evidence.candidates.push({ email, sourceUrl, sourceType, outcome: "selected", dns: check.reason });
      return { email, sourceUrl, sourceType, check, evidence };
    }
    return null;
  };

  const existing = normalizeEmail(fields.Email);
  if (existing) {
    evidence.tried.push({ type: "overture", url: text(fields["Email Source URL"]) || "Overture Maps Places", status: "checked" });
    const found = await tryEmails([existing], text(fields["Email Source URL"]) || "Overture Maps Places", "overture");
    if (found) return found;
  }

  const pages = [];
  const fetchPage = async (url, type) => {
    if (!url || evidence.tried.some((item) => item.url === url)) return null;
    try {
      const page = await fetchPublicPage(url, options);
      pages.push({ ...page, type });
      evidence.tried.push({ type, url: page.url, status: "fetched", truncated: page.truncated });
      return page;
    } catch (error) {
      evidence.tried.push({ type, url, status: "failed", reason: text(error.message).slice(0, 80) });
      return null;
    }
  };

  const homepage = await fetchPage(website, "official_site");
  if (homepage) {
    const found = await tryEmails(extractVisibleEmails(homepage.html), homepage.url, "official_site", homepage.html);
    if (found) return found;
  }

  const contactLinks = homepage
    ? pageLinks(homepage.html, homepage.url)
      .filter((link) => sameSite(link.url, homepage.url) && CONTACT_HINT.test(`${link.url} ${link.label}`))
      .map((link) => link.url)
    : [];
  if (homepage) {
    for (const path of ["/contact", "/contact-us", "/about", "/about-us"]) contactLinks.push(new URL(path, homepage.url).toString());
  }
  for (const url of [...new Set(contactLinks)].slice(0, 3)) {
    const page = await fetchPage(url, "contact_or_about");
    if (!page) continue;
    const found = await tryEmails(extractVisibleEmails(page.html), page.url, "contact_or_about", page.html);
    if (found) return found;
  }

  for (const page of pages) {
    const found = await tryEmails(extractStructuredEmails(page.html), page.url, "structured_data", page.html);
    if (found) return found;
  }

  const socialValues = parseJson(fields["Social Profiles JSON"], []);
  const socialUrls = urlsInValue(socialValues).map((url) => normalizedUrl(url)).filter(Boolean);
  for (const url of [...new Set(socialUrls)].filter((url) => SOCIAL_HOSTS.test(hostname(url))).slice(0, 2)) {
    const page = await fetchPage(url, "official_social");
    if (!page) continue;
    const found = await tryEmails([...extractVisibleEmails(page.html), ...extractStructuredEmails(page.html)], page.url, "official_social", page.html);
    if (found) return found;
  }

  const publicValues = [parseJson(fields["About JSON"], {}), parseJson(fields["Raw Row JSON"], {})];
  const publicUrls = urlsInValue(publicValues)
    .map((url) => normalizedUrl(url))
    .filter((url) => url && !sameSite(url, website) && !SOCIAL_HOSTS.test(hostname(url)) && !NON_PAGE_EXTENSIONS.test(url));
  for (const url of [...new Set(publicUrls)].slice(0, 1)) {
    const page = await fetchPage(url, "public_source");
    if (!page) continue;
    const found = await tryEmails([...extractVisibleEmails(page.html), ...extractStructuredEmails(page.html)], page.url, "public_source", page.html);
    if (found) return found;
  }

  return { email: "", duplicateFound, evidence };
}

function outcomeFields(record, result, now) {
  const fields = record.fields || {};
  const attempts = Math.max(0, Number(fields["Email Enrichment Attempts"]) || 0) + 1;
  const base = {
    "Email Enrichment Checked At": now.toISOString(),
    "Email Enrichment Attempts": attempts,
    "Email Enrichment Evidence JSON": JSON.stringify(result.evidence),
    "Email Eligible": "no",
    "Lead Status Updated At": now.toISOString()
  };
  if (!result.email) {
    const duplicate = result.duplicateFound;
    return {
      ...base,
      "Email Enrichment Status": duplicate ? "duplicate_email" : "not_found",
      "Email Status": duplicate ? "duplicate" : "enrichment_not_found",
      "Lead Status": "candidate",
      "Lead Decision": "pending_enrichment",
      "Lead Decision Reason": duplicate ? "DUPLICATE_EMAIL" : "NO_PUBLIC_EMAIL_FOUND",
      "Lead Rejection Reason": ""
    };
  }

  const reusable = reusableExternalVerification(fields, result.email, { now });
  return {
    ...base,
    Email: result.email,
    "Email Source URL": result.sourceUrl,
    "Email Source Type": result.sourceType,
    "Email Enrichment Status": "found",
    "Email Status": "pending_external_verification",
    "Email DNS Check": result.check.reason,
    "Email DNS Checked At": now.toISOString(),
    "Email Disposable": result.check.disposable ? "yes" : "no",
    "Email Catch All": reusable ? lower(fields["Email Catch All"]) || "no" : "",
    "Email Risky": reusable ? lower(fields["Email Risky"]) || "no" : "",
    "Email Validation Status": reusable ? reusable.status : "PENDING_EXTERNAL_VERIFICATION",
    "Email Validation Provider": reusable ? reusable.provider : "",
    "Email Validation Checked At": reusable ? reusable.checkedAt : "",
    "Email Validation Details": reusable ? "Existing current verification can be reused in stage 5" : "Syntax and mail-domain DNS passed; mailbox not externally verified",
    "Email Validation Raw JSON": reusable ? text(fields["Email Validation Raw JSON"]) : "",
    "Email Verification Reusable": reusable ? "yes" : "no",
    "Lead Status": "enriched",
    "Lead Decision": "pending_verification",
    "Lead Decision Reason": reusable ? "CURRENT_EXTERNAL_VERIFICATION_REUSABLE" : "PENDING_EXTERNAL_VERIFICATION",
    "Lead Rejection Reason": ""
  };
}

async function mapConcurrent(items, concurrency, operation) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export async function enrichOvertureEmails(dependencies, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const tableId = dependencies.config.airtable.rawOutscraperTableId;
  const records = options.records || await dependencies.data.listRecords(tableId, { fields: [
    "Source System", "Lead Status", "Lead Decision", "Business Name", "Email", "Website",
    "About JSON", "Raw Row JSON", "Social Profiles JSON", "Email Source URL",
    "Email Enrichment Status", "Email Enrichment Checked At", "Email Enrichment Attempts",
    "Email Validation Status", "Email Validation Provider", "Email Validation Checked At",
    "Email Validation Raw JSON", "Email Catch All", "Email Disposable", "Email Risky"
  ] });
  const selected = selectEnrichmentCandidates(records, { ...options, now });
  const emailOwners = new Map();
  for (const record of records) {
    const email = normalizeEmail(record.fields?.Email);
    if (email && !emailOwners.has(email)) emailOwners.set(email, record.id);
  }
  const context = { emailOwners };
  const summary = { success: true, dryRun: Boolean(options.dryRun), selected: selected.length, found: 0, notFound: 0, duplicates: 0, errors: 0, updated: 0, results: [] };

  await mapConcurrent(selected, Math.max(1, Math.min(5, Number(options.concurrency) || 3)), async (record) => {
    try {
      const result = await inspectRecord(record, context, options);
      const updates = outcomeFields(record, result, now);
      if (result.email) summary.found += 1;
      else if (result.duplicateFound) summary.duplicates += 1;
      else summary.notFound += 1;
      if (!options.dryRun) {
        await dependencies.data.updateRecordInTable(tableId, record.id, updates);
        summary.updated += 1;
      }
      summary.results.push({
        recordId: record.id,
        businessName: text(record.fields?.["Business Name"]),
        status: updates["Email Enrichment Status"],
        email: result.email,
        sourceUrl: result.sourceUrl || "",
        sourceType: result.sourceType || "",
        tried: result.evidence.tried.length
      });
    } catch (error) {
      summary.errors += 1;
      const attempts = Math.max(0, Number(record.fields?.["Email Enrichment Attempts"]) || 0) + 1;
      const updates = {
        "Email Enrichment Status": "error",
        "Email Enrichment Checked At": now.toISOString(),
        "Email Enrichment Attempts": attempts,
        "Email Enrichment Evidence JSON": JSON.stringify({ version: 1, recordId: record.id, error: text(error.message).slice(0, 200) }),
        "Email Eligible": "no",
        "Lead Status": "candidate",
        "Lead Status Updated At": now.toISOString(),
        "Lead Decision": "pending_enrichment",
        "Lead Decision Reason": "ENRICHMENT_ERROR"
      };
      if (!options.dryRun) {
        await dependencies.data.updateRecordInTable(tableId, record.id, updates);
        summary.updated += 1;
      }
      summary.results.push({ recordId: record.id, businessName: text(record.fields?.["Business Name"]), status: "error" });
    }
  });
  summary.results.sort((left, right) => left.recordId.localeCompare(right.recordId));
  return summary;
}

export async function resetFoundEnrichment(dependencies, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const tableId = dependencies.config.airtable.rawOutscraperTableId;
  const records = options.records || await dependencies.data.listRecords(tableId, { fields: [
    "Source System", "Email", "Email Source URL", "Email Source Type", "Email Enrichment Status",
    "Email Enrichment Evidence JSON"
  ] });
  const found = records.filter((record) => lower(record.fields?.["Source System"]) === "overture")
    .filter((record) => lower(record.fields?.["Email Enrichment Status"]) === "found");
  let updated = 0;
  for (const record of found) {
    const fields = record.fields || {};
    const reset = {
      "Intake Status": "candidate",
      Email: "",
      "Email Source URL": "",
      "Email Source Type": "",
      "Email Status": "enrichment_required",
      "Email Eligible": "no",
      "Email DNS Check": "",
      "Email DNS Checked At": "",
      "Email Validation Status": "NOT_CHECKED",
      "Email Validation Provider": "",
      "Email Validation Checked At": "",
      "Email Validation Details": "Reopened for stage 4 source-association check",
      "Email Validation Raw JSON": "",
      "Email Catch All": "",
      "Email Disposable": "",
      "Email Risky": "",
      "Email Verification Reusable": "no",
      "Email Enrichment Status": "",
      "Email Enrichment Checked At": "",
      "Email Enrichment Attempts": 0,
      "Email Enrichment Previous Evidence JSON": JSON.stringify({
        resetAt: now.toISOString(),
        email: text(fields.Email),
        sourceUrl: text(fields["Email Source URL"]),
        sourceType: text(fields["Email Source Type"]),
        evidence: parseJson(fields["Email Enrichment Evidence JSON"], {})
      }),
      "Email Enrichment Evidence JSON": "",
      "Lead Status": "candidate",
      "Lead Status Updated At": now.toISOString(),
      "Lead Decision": "pending_enrichment",
      "Lead Decision Reason": "RECHECK_SOURCE_ASSOCIATION",
      "Lead Rejection Reason": ""
    };
    if (!options.dryRun) {
      await dependencies.data.updateRecordInTable(tableId, record.id, reset);
      updated += 1;
    }
  }
  return { success: true, dryRun: Boolean(options.dryRun), selected: found.length, updated };
}
