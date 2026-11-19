 // controllers/businessVerificationController.js
import { lookupNIN } from "../lib/youverify.js";
import * as businessRepo from "../lib/businessProfilesRepo.js";

const tokens = (s) => (s || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);

// Never send these to the browser
const toPublic = ({ nin_hash, nin_number, phone_verification_code, ...rest }) => rest;

export async function verifyBusinessNIN(req, res) {
  try {
    const { nin, consent } = req.body;
    if (!/^\d{11}$/.test(nin || "")) {
      return res.status(400).json({ success: false, message: "NIN must be 11 digits." });
    }
    if (consent !== true) {
      return res.status(400).json({ success: false, message: "Consent is required." });
    }

    const business = await businessRepo.findById(req.userId);
    if (!business) return res.status(404).json({ success: false, message: "Business profile not found." });
    if (business.nin_verified) return res.json({ success: true, data: toPublic(business) }); // don't pay twice

    const owner = tokens(business.owner_name);
    if (!owner.length) {
      return res.status(400).json({ success: false, message: "Add your owner name first." });
    }

    const person = await lookupNIN(nin);
    console.log("Youverify NIN fields:", Object.keys(person || {})); // confirm names in sandbox, then delete this line

    // Sandbox returns mock names, so the name check is skipped there only.
    // It switches itself back on when the base URL is the production one.
    const isSandbox = (process.env.YOUVERIFY_BASE_URL || "").includes("sandbox");

    if (!isSandbox) {
      const first = tokens(person?.firstName)[0];
      const last = tokens(person?.lastName)[0];
      if (!first || !last) {
        return res.status(502).json({ success: false, message: "Verification service returned an unexpected response." });
      }
      if (!owner.includes(first) || !owner.includes(last)) {
        return res.status(422).json({ success: false, message: "The name on this NIN doesn't match your owner name." });
      }
    }

    const updated = await businessRepo.verifyNIN(req.userId, nin);
    return res.json({ success: true, data: toPublic(updated) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    if ([400, 404, 422].includes(err.upstreamStatus)) {
      return res.status(422).json({ success: false, message: "We couldn't verify that NIN. Check the number and try again." });
    }
    console.error(err);
    return res.status(502).json({ success: false, message: "Verification service is unavailable. Try again later." });
  }
}