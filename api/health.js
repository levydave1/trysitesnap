export default function handler(_request, response) {
  response.setHeader("Cache-Control", "no-store");
  return response.status(200).json({ status: "ok", service: "sitesnap-webhooks", version: "1.0.0" });
}

