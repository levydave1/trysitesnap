function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents || "{}");
    var expected = PropertiesService.getScriptProperties().getProperty("MAIL_RELAY_SECRET");
    if (!expected || payload.secret !== expected) return jsonResponse({ success: false, error: "unauthorized" });
    if (!payload.to || !payload.subject || !payload.html) return jsonResponse({ success: false, error: "missing fields" });
    GmailApp.sendEmail(String(payload.to), String(payload.subject), "This message requires an HTML-capable email client.", {
      htmlBody: String(payload.html),
      name: "SiteSnap"
    });
    return jsonResponse({ success: true });
  } catch (error) {
    return jsonResponse({ success: false, error: String(error && error.message || error) });
  }
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
