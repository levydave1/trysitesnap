export const config = Object.freeze({
  cloudflare: {
    accountId: "7502f6ada6e0d09a80d12924fb90c4fb",
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
      businessName: "fldjZ336x5hA6KRZn",
      registrantAddress: "fldW5tLMqmQuOxSts",
      registrantCity: "fldURJno74xXwtnjH",
      registrantState: "fld4NjCjsVzyHIlgE",
      registrantZip: "fld3ZSYuJSplJUlZj",
      registrantCountry: "fldvbxXcQTao3j315",
      consent: "fldFvDQe8Ip2FEg5v",
      paymentStatus: "fldstbxVm4fdgSYkH"
    }
  },
  compatibility: {
    registrationStateSource: "registrant_country",
    paymentStatusValue: "not yes"
  },
  allowedOrigins: ["https://trysitesnap.com", "https://www.trysitesnap.com"],
  upstreamTimeoutMs: 15000,
  bodyBytes: 65536
});

