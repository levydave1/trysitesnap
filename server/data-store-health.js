export async function checkDataStore(dependencies) {
  const backend = dependencies.dataBackend || "airtable";
  if (typeof dependencies.airtable?.healthCheck === "function") {
    await dependencies.airtable.healthCheck();
  } else {
    await dependencies.airtable.listRecords(dependencies.config.airtable.tableId, {
      fields: [dependencies.config.airtable.fields.jobBusinessName],
      maxRecords: 1
    });
  }
  return {
    success: true,
    backend,
    database: "reachable"
  };
}
