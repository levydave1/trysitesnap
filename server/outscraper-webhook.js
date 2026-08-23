import { createHmac, timingSafeEqual } from "node:crypto";

const acceptedEmailStatuses = new Set(["RECEIVING", "VALID", "DELIVERABLE"]);

const fieldMap = Object.freeze({
  query: "Outscraper Query",
  name: "Business Name",
  name_for_emails: "Name For Emails",
  category: "Category",
  type: "Type",
  subtypes: "Subtypes",
  business_status: "Business Status",
  area_service: "Area Service",
  email: "Email",
  "email.emails_validator.status": "Email Validation Status",
  "email.emails_validator.status_details": "Email Validation Details",
  phone: "Phone",
  company_phone: "Company Phone",
  company_phones: "Company Phones",
  contact_phone: "Contact Phone",
  contact_phones: "Contact Phones",
  full_name: "Full Name",
  first_name: "First Name",
  last_name: "Last Name",
  title: "Title",
  owner_id: "Owner ID",
  owner_title: "Owner Title",
  owner_link: "Owner Link",
  website: "Website",
  domain: "Domain",
  company_name: "Company Name / Domain Name",
  website_title: "Website Title",
  website_description: "Website Description",
  website_generator: "Website Generator",
  website_has_gtm: "Website Has GTM",
  website_has_fb_pixel: "Website Has FB Pixel",
  source: "Source Page",
  address: "Address",
  street: "Street",
  city: "City",
  county: "County",
  state: "State",
  state_code: "State Code",
  postal_code: "Postal Code",
  country: "Country",
  country_code: "Country Code",
  latitude: "Latitude",
  longitude: "Longitude",
  time_zone: "Time Zone",
  plus_code: "Plus Code",
  located_in: "Located In",
  located_google_id: "Located Google ID",
  location_link: "Location Link",
  location_reviews_link: "Location Reviews Link",
  place_id: "Place ID",
  google_id: "Google ID",
  cid: "CID",
  kgmid: "KG MID",
  reviews_id: "Reviews ID",
  company_linkedin: "Company LinkedIn",
  company_facebook: "Company Facebook",
  company_instagram: "Company Instagram",
  company_x: "Company X",
  company_youtube: "Company YouTube",
  contact_linkedin: "Contact LinkedIn",
  contact_facebook: "Contact Facebook",
  contact_instagram: "Contact Instagram",
  contact_x: "Contact X",
  rating: "Rating",
  reviews: "Reviews Count",
  reviews_link: "Reviews Link",
  reviews_tags: "Reviews Tags",
  reviews_per_score: "Reviews Per Score JSON",
  reviews_per_score_1: "Reviews 1 Star",
  reviews_per_score_2: "Reviews 2 Star",
  reviews_per_score_3: "Reviews 3 Star",
  reviews_per_score_4: "Reviews 4 Star",
  reviews_per_score_5: "Reviews 5 Star",
  photos_count: "Photos Count",
  photo: "Main Photo URL",
  street_view: "Street View URL",
  logo: "Logo URL",
  working_hours: "Working Hours JSON",
  working_hours_csv_compatible: "Working Hours CSV",
  other_hours: "Other Hours",
  popular_times: "Popular Times",
  typical_time_spent: "Typical Time Spent",
  range: "Price Range",
  prices: "Prices",
  reservation_links: "Reservation Links",
  booking_appointment_link: "Booking Appointment Link",
  menu_link: "Menu Link",
  order_links: "Order Links",
  about: "About JSON",
  description: "Description",
  posts: "Posts",
  "company_insights.employees": "Employees",
  "company_insights.revenue": "Revenue",
  "company_insights.founded_year": "Founded Year",
  "company_insights.industry": "Industry",
  "company_insights.is_public": "Is Public Company",
  "company_insights.name": "Insight Company Name"
});

function text(value) {
  return String(value ?? "").trim();
}

function normalizedEmail(value) {
  return text(value).toLowerCase();
}

function stableValue(value) {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function walkResults(value, output) {
  if (Array.isArray(value)) {
    for (const item of value) walkResults(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.name || value.place_id || value.cid || value.email || value.website) {
    output.push(value);
    return;
  }
  if ("data" in value) walkResults(value.data, output);
}

export function verifyOutscraperWebhook(rawBody, signatureHeader, apiKey) {
  if (!apiKey) throw new Error("OUTSCRAPER_API_KEY is not configured");
  const signature = text(signatureHeader).replace(/^sha256=/i, "");
  const expected = createHmac("sha256", apiKey).update(rawBody).digest();
  let candidate;
  try {
    candidate = Buffer.from(signature, "hex");
  } catch {
    candidate = Buffer.alloc(0);
  }
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    const error = new Error("Invalid Outscraper signature");
    error.status = 400;
    throw error;
  }
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    const error = new Error("Invalid Outscraper JSON payload");
    error.status = 400;
    throw error;
  }
}

export function selectLeadRows(payload, existingRecords = [], maxLeads = 120) {
  const rows = [];
  walkResults(payload, rows);
  const existingEmails = new Set(existingRecords.map((record) => normalizedEmail(record.fields?.Email)).filter(Boolean));
  const existingBusinessIds = new Set(existingRecords.flatMap((record) => [
    text(record.fields?.CID),
    text(record.fields?.["Google ID"]),
    text(record.fields?.["Place ID"])
  ]).filter(Boolean));
  const selected = [];
  const runEmails = new Set();
  const runBusinesses = new Set();

  for (const row of rows) {
    const email = normalizedEmail(row.email);
    const status = text(row["email.emails_validator.status"]).toUpperCase();
    const businessStatus = text(row.business_status).toUpperCase();
    const businessId = text(row.cid || row.google_id || row.place_id);
    if (!text(row.name) || !text(row.website) || !email || !acceptedEmailStatuses.has(status)) continue;
    if (businessStatus && businessStatus !== "OPERATIONAL") continue;
    if (existingEmails.has(email) || runEmails.has(email)) continue;
    if (businessId && (existingBusinessIds.has(businessId) || runBusinesses.has(businessId))) continue;
    selected.push(row);
    runEmails.add(email);
    if (businessId) runBusinesses.add(businessId);
    if (selected.length >= maxLeads) break;
  }
  return { discovered: rows.length, selected };
}

export function airtableFieldsForLead(row, { runName, now = new Date() } = {}) {
  const fields = {
    "Intake Status": "imported",
    "Email Status": "not_started",
    "Video Status": "not_started",
    "Email Eligible": "yes",
    "Video Eligible": "yes",
    "Source System": "outscraper",
    "Source Run Name": text(runName) || "Outscraper daily",
    "Last Seen At": now.toISOString(),
    "Dedup Key": text(row.cid || row.google_id || row.place_id || normalizedEmail(row.email)),
    "Raw Row JSON": JSON.stringify(row)
  };
  for (const [source, target] of Object.entries(fieldMap)) {
    const value = stableValue(row[source]);
    if (value !== undefined) fields[target] = value;
  }
  return fields;
}

export async function processOutscraperWebhook(event, dependencies, options = {}) {
  const status = text(event?.status).toUpperCase();
  if (status !== "SUCCESS") return { success: true, skipped: true, reason: status || "MISSING_STATUS" };
  if (!event?.results_location) {
    const error = new Error("Outscraper webhook has no results location");
    error.status = 400;
    throw error;
  }
  const maxLeads = Math.min(120, Math.max(1, Number(options.maxLeads || dependencies.config.outscraper.dailyMaxLeads || 120)));
  const payload = await dependencies.outscraper.getRequestResults(event.results_location);
  const existing = await dependencies.airtable.listRecords(dependencies.config.airtable.rawOutscraperTableId, {
    fields: ["CID", "Google ID", "Place ID", "Email"]
  });
  const { discovered, selected } = selectLeadRows(payload, existing, maxLeads);
  const now = options.now || new Date();
  const runName = `Outscraper daily ${text(event.id).slice(0, 36)}`;
  const records = selected.map((row) => airtableFieldsForLead(row, { runName, now }));
  const created = [];
  for (let index = 0; index < records.length; index += 10) {
    created.push(...await dependencies.airtable.createRecords(
      dependencies.config.airtable.rawOutscraperTableId,
      records.slice(index, index + 10)
    ));
    if (index + 10 < records.length) await new Promise((resolve) => setTimeout(resolve, 225));
  }
  const result = {
    success: true,
    requestId: text(event.id),
    discovered,
    eligible: selected.length,
    created: created.length,
    belowTarget: created.length < Number(dependencies.config.outscraper.dailyMinLeads || 100)
  };
  if (dependencies.telegram) {
    const marker = result.belowTarget ? "⚠️" : "✅";
    try {
      await dependencies.telegram.send(`${marker} Outscraper daily\n${result.created} new leads imported to Airtable\n${result.discovered} result rows inspected`);
    } catch (error) {
      console.error(JSON.stringify({ event: "outscraper_import_notification_failed", message: text(error?.message).slice(0, 200) }));
    }
  }
  return result;
}
