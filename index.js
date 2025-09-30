// index.js
// IntelliPark backend — Express + Firebase Admin + Xendit
// Works on Render. Requires env vars:
// - FIREBASE_SERVICE_ACCOUNT (entire JSON, with \n in private_key)
// - XENDIT_API_KEY
// - XENDIT_WEBHOOK_TOKEN
// - PORT (optional; defaults to 8080)

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const admin = require("firebase-admin");

// Load env (optional for local dev)
try { require("dotenv").config(); } catch (_) {}

const app = express();

// Keep body small and fast; JSON for API routes
app.use(cors());
app.use(express.json({ type: "*/*", limit: "1mb" }));

// ---------- Firebase Admin ----------
let serviceAccount;
const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (raw) {
  // Convert escaped \n to real newlines so PEM parses correctly
  serviceAccount = JSON.parse(
    raw,
    (k, v) => (k === "private_key" ? String(v).replace(/\\n/g, "\n") : v)
  );
} else {
  // Local fallback only (do not include the file in production)
  // eslint-disable-next-line import/no-dynamic-require, global-require
  serviceAccount = require("./serviceAccountKey.json");
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://intellipark2025-327e9-default-rtdb.firebaseio.com"
  });
}
const db = admin.database();

// ---------- Config ----------
const PORT = process.env.PORT || 8080;
const XENDIT_API_KEY = process.env.XENDIT_API_KEY || "";
const XENDIT_WEBHOOK_TOKEN = process.env.XENDIT_WEBHOOK_TOKEN || "";

// Health check
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "intellipark-backend", time: Date.now() });
});

// ---------- Create Invoice ----------
app.post("/api/create-invoice", async (req, res) => {
  try {
    const { email, slotId, amount } = req.body || {};
    if (!email || !slotId) {
      return res.status(400).json({ error: "email and slotId are required" });
    }
    if (!XENDIT_API_KEY) {
      return res.status(500).json({ error: "XENDIT_API_KEY missing" });
    }

    // Success redirect goes to your hosted confirmation page
    const successURL = `https://intellipark2025-327e9.web.app/confirmation.html?slot=${encodeURIComponent(
      slotId
    )}&email=${encodeURIComponent(email)}`;

    // Compose invoice request
    const body = {
      external_id: `SLOT-${slotId}-${Date.now()}`,
      amount: Number(amount) || 50,
      currency: "PHP",
      description: `Reservation for ${slotId}`,
      payer_email: email,
      success_redirect_url: successURL,
      invoice_duration: 900 // 15 minutes
    };

    const response = await fetch("https://api.xendit.co/v2/invoices", {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${XENDIT_API_KEY}:`).toString("base64"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const result = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(result);
    }

    // Optionally store invoice draft
    try {
      await db.ref(`payments/${result.id}`).set({
        status: result.status,
        externalId: result.external_id,
        resourceId: result.id,
        createdAt: Date.now(),
        raw: result
      });
    } catch (e) {
      // Non-fatal
      // eslint-disable-next-line no-console
      console.warn("Failed to persist draft invoice:", e.message);
    }

    return res.json(result);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("create-invoice error:", err);
    return res.status(500).json({ error: "Failed to create invoice" });
  }
});

// ---------- Xendit Webhook ----------
app.post("/api/webhooks/xendit", async (req, res) => {
  try {
    // Verify callback token
    const token = req.header("x-callback-token");
    if (!token || token !== XENDIT_WEBHOOK_TOKEN) {
      return res.status(403).send("Forbidden");
    }

    const evt = req.body || {};
    const resourceId = evt.id || (evt.data && evt.data.id);
    const externalId = evt.external_id || (evt.data && evt.data.external_id);
    const status =
      evt.status || (evt.data && evt.data.status) || evt.event || "UNKNOWN";

    // Idempotent upsert
    const key = resourceId || externalId;
    if (key) {
      await db.ref(`payments/${key}`).update({
        status,
        externalId: externalId || null,
        resourceId: resourceId || null,
        lastUpdateAt: Date.now(),
        raw: evt
      });
    }

    // Link to slot by external_id convention "SLOT-<slotId>-<timestamp>"
    let slotId = null;
    if (externalId && externalId.startsWith("SLOT-")) {
      const parts = externalId.split("-");
      slotId = parts[1];
    }

    if (slotId) {
      const isPaid = String(status).toUpperCase().includes("PAID");

      if (isPaid) {
        // If using a pending bucket, migrate to confirmed reservation
        const pendingSnap = await db.ref(`pending/${slotId}`).get();
        if (pendingSnap.exists()) {
          const data = pendingSnap.val();
          await db.ref(`reservations/${slotId}`).set({
            ...data,
            paymentStatus: status,
            paidAt: Date.now()
          });
          // Mark slot reserved (adjust to your schema)
          await db.ref(`${slotId}`).update({ status: "Reserved", reserved: true });
          await db.ref(`pending/${slotId}`).remove();
        } else {
          // Just update reservations if pending doesn’t exist
          await db.ref(`reservations/${slotId}`).update({
            paymentStatus: status,
            paidAt: Date.now()
          });
        }
      } else {
        await db.ref(`reservations/${slotId}`).update({
          paymentStatus: status,
          lastUpdated: Date.now()
        });
      }
    }

    // Always 200 on success to avoid retries
    return res.sendStatus(200);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Webhook error:", err);
    // 5xx triggers Xendit retries
    return res.sendStatus(500);
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`✅ IntelliPark backend running on port ${PORT}`);
});
