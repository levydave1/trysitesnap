import { randomUUID } from "node:crypto";
import { deliveryEmail, domainEmail, prepareDeliveredHtml } from "./templates.js";

const recordIdPattern = /^rec[a-zA-Z0-9]{14,}$/;
const domainPattern = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

function recordId(value) {
  const normalized = String(value || "").trim();
  if (!recordIdPattern.test(normalized)) throw new Error("Invalid Airtable record ID");
  return normalized;
}

function domainName(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
  if (!domainPattern.test(normalized)) throw new Error("Invalid domain name");
  return normalized;
}

function text(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : Number.POSITIVE_INFINITY;
}

function purchaseEligible(check, maxUsd) {
  return check?.registrable === true &&
    check?.tier === "standard" &&
    number(check?.pricing?.registration_cost) <= maxUsd &&
    number(check?.pricing?.renewal_cost) <= maxUsd;
}

function checkoutSession(event) {
  if (event?.type !== "checkout.session.completed") return null;
  const session = event?.data?.object;
  if (!session || session.payment_status !== "paid") return null;
  return session;
}

function purchaseReference(value) {
  const [rawRecord, rawDomain, ...rest] = text(value).split("__");
  if (!rawRecord || !rawDomain || rest.length) return null;
  return { recordId: recordId(rawRecord), domain: domainName(rawDomain.replaceAll("_dot_", ".")) };
}

async function notifications(items) {
  const results = await Promise.allSettled(items.filter(Boolean));
  return results.map((result) => result.status === "fulfilled" ? "sent" : "failed");
}

function registrationContact(fields) {
  return {
    email: text(fields["Domain Registration Email"]),
    phone: text(fields["Domain Registration Phone"]),
    postal_info: {
      name: text(fields["Domain Registration Full Name"]),
      organization: text(fields["Domain Registration Business Name"]),
      address: {
        street: text(fields["Domain Registration Address"]),
        city: text(fields["Domain Registration City"]),
        state: text(fields["Domain Registration State"]),
        postal_code: text(fields["Domain Registration ZIP"]),
        country_code: text(fields["Domain Registration Country"])
      }
    }
  };
}

export async function processDomainPurchase(event, dependencies, options = {}) {
  const session = checkoutSession(event);
  if (session?.payment_link && session.payment_link !== dependencies.config.stripe.paymentLinks.newDomain) {
    return { handled: false, reason: "not_new_domain_payment_link" };
  }
  const reference = purchaseReference(session?.client_reference_id);
  if (!session || !reference) return { handled: false, reason: "not_domain_purchase" };

  const { airtable, cloudflare, mail, telegram, config } = dependencies;
  const { recordId: id, domain } = reference;
  const record = await airtable.getRecord(id);
  const fields = record.fields || {};
  const businessName = text(fields["Business Name"] || fields["Domain Registration Business Name"], "Customer");
  const customerEmail = text(fields["Domain Registration Email"] || session.customer_details?.email);
  const currentStatus = text(fields.Status);
  const currentNotes = text(fields.Notes);

  if (/Domain Purchased|Domain Purchase Processing/i.test(currentStatus)) {
    return { handled: true, duplicate: true, status: currentStatus, domain };
  }
  if (/Manual Review|Domain Purchase Error/i.test(currentStatus) && !options.testMode) {
    return { handled: true, duplicate: true, status: currentStatus, domain };
  }
  if (/^domain-purchase:/i.test(currentNotes) && !options.testMode) {
    return { handled: true, duplicate: true, status: currentStatus || "purchase_locked", domain };
  }

  const existing = await cloudflare.getRegistration(domain);
  if (existing) {
    if (!options.testMode) {
      await airtable.updateRecord(id, {
        [config.airtable.fields.finalDomain]: domain,
        [config.airtable.fields.status]: "Domain Purchased",
        [config.airtable.fields.paymentStatus]: "paid",
        [config.airtable.fields.notes]: `paid:${event.id}`
      });
    }
    return { handled: true, duplicate: true, status: "Domain Purchased", domain };
  }

  const check = (await cloudflare.checkDomains([domain]))[0] || {};
  const eligible = purchaseEligible(check, config.cloudflare.purchaseMaxUsd);
  if (options.testMode) {
    return {
      handled: true,
      testMode: true,
      domain,
      eligible,
      registrable: check.registrable === true,
      tier: check.tier || null,
      registrationCost: check.pricing?.registration_cost || null,
      renewalCost: check.pricing?.renewal_cost || null,
      wouldPurchase: eligible
    };
  }

  if (!eligible) {
    await airtable.updateRecord(id, {
      [config.airtable.fields.finalDomain]: domain,
      [config.airtable.fields.status]: "Manual Review - Domain Check Failed",
      [config.airtable.fields.paymentStatus]: "paid",
      [config.airtable.fields.notes]: `paid:${event.id}`
    });
    const email = domainEmail("review", { businessName, domain, recordId: id });
    await notifications([
      customerEmail && mail?.send({ to: customerEmail, ...email }),
      telegram?.send(`🚨 MANUAL REVIEW - DO NOT PURCHASE\n\nBusiness: ${businessName}\nRecord ID: ${id}\nDomain: ${domain}\nRegistrable: ${String(check.registrable)}\nTier: ${check.tier || "n/a"}\nRegistration: $${check.pricing?.registration_cost || "n/a"}\nRenewal: $${check.pricing?.renewal_cost || "n/a"}`)
    ]);
    return { handled: true, status: "Manual Review - Domain Check Failed", domain };
  }

  const lock = `domain-purchase:${event.id}:${randomUUID()}`;
  await airtable.updateRecord(id, {
    [config.airtable.fields.finalDomain]: domain,
    [config.airtable.fields.status]: "Paid - Ready to Purchase",
    [config.airtable.fields.paymentStatus]: "paid",
    [config.airtable.fields.notes]: lock
  });
  const locked = await airtable.getRecord(id);
  if (text(locked.fields?.Notes) !== lock) {
    return { handled: true, duplicate: true, status: "purchase_lock_superseded", domain };
  }

  try {
    const registration = await cloudflare.registerDomain({
      domain_name: domain,
      years: 1,
      auto_renew: false,
      privacy_mode: "redaction",
      contacts: { registrant: registrationContact(fields) }
    });
    const kind = registration.status === 201 ? "purchased" : "processing";
    const status = kind === "purchased" ? "Domain Purchased" : "Domain Purchase Processing";
    await airtable.updateRecord(id, {
      [config.airtable.fields.finalDomain]: domain,
      [config.airtable.fields.status]: status,
      [config.airtable.fields.paymentStatus]: "paid",
      [config.airtable.fields.notes]: `paid:${event.id}`
    });
    const email = domainEmail(kind, { businessName, domain, recordId: id });
    await notifications([
      customerEmail && mail?.send({ to: customerEmail, ...email }),
      telegram?.send(`${kind === "purchased" ? "✅ DOMAIN PURCHASED" : "⏳ DOMAIN PURCHASE PROCESSING"}\n\nBusiness: ${businessName}\nRecord ID: ${id}\nDomain: ${domain}\nStripe session: ${session.id}\nCloudflare HTTP: ${registration.status}\nState: ${registration.data.state || "n/a"}`)
    ]);
    return { handled: true, status, domain, cloudflareStatus: registration.status };
  } catch (error) {
    await airtable.updateRecord(id, {
      [config.airtable.fields.status]: "Domain Purchase Error",
      [config.airtable.fields.notesLog]: `Domain purchase failed for ${domain}: ${text(error.message).slice(0, 400)}`
    });
    await notifications([
      telegram?.send(`🚨 DOMAIN PURCHASE ERROR\n\nBusiness: ${businessName}\nRecord ID: ${id}\nDomain: ${domain}\n${text(error.message).slice(0, 500)}`)
    ]);
    throw error;
  }
}

function deliveryPlan(paymentLink, paymentLinks) {
  if (paymentLink === paymentLinks.existingDomain) return "existing";
  if (paymentLink === paymentLinks.subdomain) return "subdomain";
  if (paymentLink === paymentLinks.newDomain) return "new_domain";
  return null;
}

export async function processSiteDelivery(event, dependencies, options = {}) {
  const session = checkoutSession(event);
  if (!session) return { handled: false, reason: "not_paid_checkout" };
  const { airtable, vercelDelivery, mail, telegram, config } = dependencies;
  const plan = options.plan || deliveryPlan(session.payment_link, config.stripe.paymentLinks);
  if (!plan || plan === "new_domain") return { handled: false, reason: plan || "unknown_payment_link" };

  const id = recordId(options.recordId || session.client_reference_id);
  const record = await airtable.getRecord(id);
  const fields = record.fields || {};
  if (text(fields.Notes) === `delivery:${event.id}` && !options.testMode) {
    return { handled: true, duplicate: true, domain: text(fields["final domain"]) };
  }

  const businessName = text(fields["Business Name"], "Customer");
  const businessId = text(fields["Business ID"]);
  const customerEmail = text(fields["Customer Email"] || fields.Email);
  const html = prepareDeliveredHtml(options.htmlSource || fields["HTML-TAKE2"], id);
  const domain = domainName(options.domain || (plan === "existing"
    ? fields["User Input URL"]
    : `${text(fields.Domain_Slug)}.trysitesnap.com`));

  const deployment = await vercelDelivery.deployHtml(html, config.vercelDelivery.projectName);
  if (!deployment.id) throw new Error("Vercel did not return a deployment ID");
  const targets = plan === "existing" && !domain.startsWith("www.") ? [domain, `www.${domain}`] : [domain];
  const aliases = [];
  for (const target of targets) {
    await vercelDelivery.addProjectDomain(target);
    aliases.push(await vercelDelivery.assignAlias(deployment.id, target));
  }
  const alias = aliases[0] || {};
  const deliveredDomain = domainName(alias.alias || domain);
  await airtable.updateRecord(id, {
    [config.airtable.fields.finalHtml]: html,
    [config.airtable.fields.finalDomain]: deliveredDomain,
    [config.airtable.fields.generatedSiteUrl]: `https://${deliveredDomain}`,
    [config.airtable.fields.notes]: `delivery:${event.id}`
  });

  if (!options.skipNotifications) {
    const email = deliveryEmail(plan, { businessName, businessId, domain: deliveredDomain });
    await notifications([
      customerEmail && mail?.send({ to: customerEmail, ...email }),
      telegram?.send(plan === "existing"
        ? `פרטים לחיבור דומיין קיים נשלחו ל\n\n${businessName}\n${deliveredDomain}`
        : `האתר ${deliveredDomain} נמסר ל ${businessName}`)
    ]);
  }
  return { handled: true, plan, domain: deliveredDomain, deploymentId: deployment.id };
}

export async function recordSketchOpened(body, dependencies) {
  const { airtable, telegram, config } = dependencies;
  const id = recordId(body?.record_id);
  const date = new Date(body?.opened_at);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid opened_at");
  const openedAt = date.toISOString();
  const record = await airtable.getRecord(id);
  const existing = text(record.fields?.["sketch opened"]);
  if (existing) return { success: true, duplicate: true, opened_at: existing };
  await airtable.updateRecord(id, { [config.airtable.fields.sketchOpened]: openedAt });
  const businessName = text(record.fields?.["Business Name"], id);
  const notification = await notifications([
    telegram?.send(`סקיצה נפתחה ל\n${businessName}\n\n${openedAt}`)
  ]);
  return { success: true, opened_at: openedAt, notification: notification[0] || "skipped" };
}
