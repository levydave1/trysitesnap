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
    }
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

