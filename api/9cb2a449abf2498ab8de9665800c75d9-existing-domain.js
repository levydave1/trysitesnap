import { existingDomain } from "../server/handlers.js";
import { createVercelHandler } from "../server/vercel.js";

export default createVercelHandler({
  method: ["GET", "POST"],
  action: existingDomain,
  needsAirtable: true
});

