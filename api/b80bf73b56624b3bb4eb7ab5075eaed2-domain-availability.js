import { domainAvailability } from "../server/handlers.js";
import { createVercelHandler } from "../server/vercel.js";

export default createVercelHandler({
  method: ["POST"],
  action: domainAvailability,
  needsCloudflare: true
});

