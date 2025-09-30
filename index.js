const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fetch = require("node-fetch");
const admin = require("firebase-admin");

// ✅ Firebase Admin
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://intellipark2025-327e9-default-rtdb.firebaseio.com"
});

const db = admin.database();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(bodyParser.json());

// ✅ Environment Variables (Replace with your actual tokens)
const XENDIT_API_KEY = process.env.XENDIT_API_KEY || "xnd_development_pPITsOGqqgRCupBylYT10cs6XrPdqLvrihSv8ENoyup3WaHjeh7UalFISZl5v";
const XENDIT_WEBHOOK_TOKEN = process.env.XENDIT_WEBHOOK_TOKEN || "GVqT7oK1shCSX8lFvOx79GVGcclHl2cEEXYpMN4vxuVsucDP";

// ✅ Create invoice endpoint
app.post("/api/create-invoice", async (req, res) => {
  try {
    const { email, slotId } = req.body;
    const successURL = `https://intellipark2025-327e9.web.app/confirmation.html?slot=${encodeURIComponent(slotId)}&email=${encodeURIComponent(email)}`;

    const response = await fetch("https://api.xendit.co/v2/invoices", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(XENDIT_API_KEY + ":").toString("base64"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        external_id: `SLOT-${slotId}-${Date.now()}`,
        amount: 50,
        currency: "PHP",
        description: `Reservation for ${slotId}`,
        payer_email: email,
        success_redirect_url: successURL,
        invoice_duration: 900
      })
    });

    const result = await response.json();
    res.json(result);
  } catch (error) {
    console.error("❌ Error creating invoice:", error);
    res.status(500).json({ error: "Failed to create invoice" });
  }
});

// ✅ Xendit Webhook endpoint with verification
app.post("/api/webhooks/xendit", async (req, res) => {
  try {
    // Verify webhook authenticity
    const callbackToken = req.header("x-callback-token");
    if (!callbackToken || callbackToken !== XENDIT_WEBHOOK_TOKEN) {
      console.error("❌ Unauthorized webhook attempt");
      return res.status(403).send("Forbidden");
    }

    const event = req.body;
    console.log("✅ Webhook received:", event);

    // Extract event details
    const resourceId = event.id || (event.data && event.data.id);
    const externalId = event.external_id || (event.data && event.data.external_id);
    const status = event.status || (event.data && event.data.status) || event.event;

    // Store payment record
    const key = resourceId || externalId;
    if (!key) {
      console.warn("⚠️ No valid key found in webhook");
      return res.sendStatus(200);
    }

    await db.ref(`payments/${key}`).update({
      status,
      externalId: externalId || null,
      resourceId: resourceId || null,
      lastUpdateAt: Date.now(),
      raw: event
    });

    // Extract slotId from external_id (format: SLOT-<slotId>-<timestamp>)
    let slotId = null;
    if (externalId && externalId.startsWith("SLOT-")) {
      const parts = externalId.split("-");
      slotId = parts[1];
    }

    // Update reservation status
    if (slotId) {
      const isPaid = String(status).toUpperCase().includes("PAID");
      
      if (isPaid) {
        // Move from pending to reservations
        const pendingSnap = await db.ref(`pending/${slotId}`).get();
        if (pendingSnap.exists()) {
          const data = pendingSnap.val();
          await db.ref(`reservations/${slotId}`).set({
            ...data,
            paymentStatus: status,
            paidAt: Date.now()
          });
          await db.ref(`${slotId}`).update({ 
            status: "Reserved", 
            reserved: true 
          });
          await db.ref(`pending/${slotId}`).remove();
          console.log(`✅ Slot ${slotId} confirmed after payment`);
        }
      } else {
        // Update payment status for other events
        await db.ref(`reservations/${slotId}`).update({
          paymentStatus: status,
          lastUpdated: Date.now()
        });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`✅ IntelliPark backend running on port ${PORT}`);
});
