function text(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return text(value).toLowerCase();
}

function linkedIds(value) {
  if (Array.isArray(value)) return value.map(text).filter((item) => item.startsWith("rec"));
  const item = text(value);
  return item.startsWith("rec") ? [item] : [];
}

function duplicateFingerprint(record) {
  const fields = record.fields || {};
  const values = [
    normalized(fields.Email),
    text(fields["Place ID"]),
    normalized(fields["Business Name"]),
    normalized(fields.Website),
    text(fields["Source Run Name"])
  ];
  return values.every(Boolean) ? JSON.stringify(values) : "";
}

export function planSafeUnsentLeadDedupe(rawRecords, threadRecords) {
  const linkedRecordIds = new Set();
  const contactedEmails = new Set();
  for (const thread of threadRecords || []) {
    for (const id of linkedIds(thread.fields?.["Business ID"])) linkedRecordIds.add(id);
    const email = normalized(thread.fields?.["To Email"]);
    if (email) contactedEmails.add(email);
  }

  const candidates = (rawRecords || []).filter((record) => {
    const fields = record.fields || {};
    const email = normalized(fields.Email);
    return record.id
      && normalized(fields["Source System"]) === "outscraper"
      && normalized(fields["Email Status"]) === "not_started"
      && normalized(fields["Email Eligible"]) === "yes"
      && email
      && !linkedRecordIds.has(record.id)
      && !contactedEmails.has(email)
      && duplicateFingerprint(record);
  });

  const groups = new Map();
  for (const record of candidates) {
    const key = duplicateFingerprint(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const deleteIds = [];
  let duplicateGroups = 0;
  for (const records of groups.values()) {
    if (records.length < 2) continue;
    duplicateGroups += 1;
    const ordered = [...records].sort((left, right) =>
      String(left.createdTime || "").localeCompare(String(right.createdTime || ""))
      || left.id.localeCompare(right.id)
    );
    deleteIds.push(...ordered.slice(1).map((record) => record.id));
  }

  return {
    scanned: (rawRecords || []).length,
    eligibleUnsent: candidates.length,
    duplicateGroups,
    deleteIds,
    keepCount: candidates.length - deleteIds.length
  };
}

