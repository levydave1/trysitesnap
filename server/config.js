export const config = Object.freeze({
  cloudflare: {
    accountId: "7502f6ada6e0d09a80d12924fb90c4fb",
    purchaseMaxUsd: 12,
    registrationMaxUsd: 15,
    renewalMaxUsd: 15
  },
  airtable: {
    baseId: "appHTGFZeyuXbRmvt",
    tableId: "tbl3pEHQ9gMSDs489",
    rawOutscraperTableId: "tblF7fN1VCF7JWlvA",
    emailThreadsTableId: "tblGP20OTbsYT8KEC",
    fields: {
      existingDomain: "fldvynrxwT7lCptbK",
      selectedDomain: "fldT7f1UgIPhyN7SP",
      registrantFullName: "fldCtjBWbQDvWYxik",
      registrantEmail: "fldE9g9Fk6axYvhK4",
      registrantPhone: "fldjjOyx38s4xv6vj",
      registrantBusinessName: "fldjZ336x5hA6KRZn",
      registrantAddress: "fldW5tLMqmQuOxSts",
      registrantCity: "fldURJno74xXwtnjH",
      registrantState: "fld4NjCjsVzyHIlgE",
      registrantZip: "fld3ZSYuJSplJUlZj",
      registrantCountry: "fldvbxXcQTao3j315",
      consent: "fldFvDQe8Ip2FEg5v",
      paymentStatus: "fldstbxVm4fdgSYkH",
      sketchOpened: "fldla6UqcgsF2KxIt",
      notes: "fld3bfyznRiKfXhcv",
      status: "fldmmeKRZgYnQ66tK",
      businessId: "fldQfagKAOFYVwgm8",
      jobBusinessName: "fldNvK0FIIkTPd1i4",
      customerEmail: "fld05Dw3vwFAXFPu9",
      htmlTake2: "fldEtD5BJNHYKFZEA",
      finalHtml: "fldGDNMESqeIq4i5t",
      domainSlug: "fldTge4ewVDJaLqek",
      finalDomain: "fldcpuGanKoHdPKCz",
      generatedSiteUrl: "fldBQozQBfC1v3bTF",
      notesLog: "fldRRzGjVM9A3FcKl"
    },
    rawOutscraperFields: {
      reviewsPerScore: "fld1Vnf4AkS9fjcvs",
      state: "fld2pJ6wNXQonZa4U",
      category: "fld324NAkX5FZm5HE",
      street: "fld4ERlg5ILek5IOX",
      photosCount: "fld4ORQLjOj4eWQkq",
      rating: "fld55uZmhkTcHyra5",
      source: "fld8Qzktv0Ik8nztK",
      reviewsId: "fldBzOdiZJE9JRlLA",
      leadSource: "fldCAyGLeMyC49W7G",
      city: "fldDFkcB2yQhgdMK7",
      workingHoursCsv: "fldDifXTDyDwAHDE7",
      email: "fldFwLWPEy9olMkwR",
      businessName: "fldGdPWfVauQeKMH3",
      subtypes: "fldHE29wUFjO8yDqh",
      about: "fldHdQ2hGWgnjJNjE",
      workingHours: "fldKJdlMbtjtxzKfQ",
      cid: "fldQPZrb6lHqSjEkV",
      type: "fldUzEbUmeBU60i5G",
      description: "fldYbga1ompa2Ee09",
      phone: "fldd34I4QdnLoRO8x",
      placeId: "fldfMiPmQz4yrElfd",
      reviewsTags: "fldfUXfFbxmoi77Mp",
      submittedAddress: "fldj1QL9UANkmpWeK",
      stateCode: "fldkig3jIwZzfNbd3",
      postalCode: "fldmDOqeWMH9W3U0p",
      reviews: "fldn010ig3ae52YmH",
      country: "fldn5TSecIviB99Py",
      photo: "fldnE8utbrFcrP9rk",
      website: "fldrOvLXoReB1EsZL",
      county: "fldsCn2KIKWBMCMJw",
      countryCode: "fldsM7kXjgWdKnY5m",
      logo: "fldyw9BlfSH6IGLWW"
    },
    emailThreadFields: {
      subject: "fld6esjeshOyRhBiC",
      body: "fld7Y0KrOrrNXSwrl",
      direction: "fld8a9b4BPbdbmE5h",
      contactName: "fldMHIgA2ZdMwkVx4",
      sender: "fldT9z9bDRRVFPwfw",
      rawBusinessRecord: "fldV8n1aIJrSifa3f",
      sentAt: "fldXnDmXBFZBMZgWE",
      instantlyLeadId: "fldiuE6MbLkikLxtO",
      businessName: "fldkQS2tbwIYOayAn",
      recipientEmail: "fldkyn5HHvY28Ozoc",
      status: "fldlFthMdDEHBfrUN",
      searchText: "flds3TpkLSye0xdTc"
    }
  },
  emailExport: {
    campaignId: "6cd2f082-7246-40c3-9b71-23b1f2fc5678",
    maxRecords: 200,
    concurrency: 4,
    timezone: "Asia/Jerusalem",
    senderLabel: "sitesnap-test (levy.dave.1@gmail.com)",
    geminiModel: "gemini-3.1-flash-lite",
    claudeModel: "claude-sonnet-4-6"
  },
  outscraper: {
    endpoint: "https://api.outscraper.cloud/google-maps-search",
    limit: 1,
    language: "en",
    region: "US",
    timeoutMs: 25000
  },
  stripe: {
    webhookToleranceSeconds: 300,
    paymentLinks: {
      existingDomain: "plink_1TQcIsAwnz8IxQfiLubTunvP",
      subdomain: "plink_1TQcJKAwnz8IxQfivOpFoUIo",
      newDomain: "plink_1TQcHdAwnz8IxQfi9Xsc7aed"
    }
  },
  vercelDelivery: {
    projectId: "prj_VLrIPS6BjxdTYIstEVkQivzV7n03",
    teamId: "team_QeeNixwxLu838ZhBk1Kj0zpB",
    projectName: "corp-preview"
  },
  notifications: {
    telegramChatId: "709427255",
    mailFrom: "office@sitesnappreview.com"
  },
  compatibility: {
    registrationStateSource: "registrant_country",
    paymentStatusValue: "not yes"
  },
  allowedOrigins: ["https://trysitesnap.com", "https://www.trysitesnap.com"],
  upstreamTimeoutMs: 15000,
  bodyBytes: 65536
});

