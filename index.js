const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fetch = require("node-fetch");
const admin = require("firebase-admin");

// ✅ Firebase Admin
const serviceAccount = require("./serviceAccountKey.json");

// Fix private_key newlines (important for Render)
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://intellipark2025-327e9-default-rtdb.firebaseio.com"
});
const db = admin.database();

const app = express();
const PORT = process.env.PORT || 8080;

// ✅ Enable CORS for your Firebase Hosting domain
app.use(cors({
  origin: "https://intellipark2025-327e9.web.app"
}));

app.use(bodyParser.json());

const XENDIT_API_KEY = process.env.XENDIT_API_KEY || "xnd_development_pPITsOGqqgRCupBylYT10cs6XrPdqLvrihSv8ENoyup3WaHjeh7UalFISZl5v";

// ✅ Create invoice
app.post("/api/create-invoice", async (req, res) => {
  try {
    const { email, slotId } = req.body;

    // Xendit will replace {id} with actual invoice id when redirecting
    const successURL = `https://intellipark2025-327e9.web.app/confirmation.html?slot=${encodeURIComponent(slotId)}&invoice_id={id}`;

    const response = await fetch("https://api.xendit.co/v2/invoices", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(XENDIT_API_KEY + ":").toString("base64"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        external_id: `resv-${Date.now()}`,
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

// ✅ Polling endpoint to check invoice
app.get("/api/check-invoice/:id", async (req, res) => {
  try {
    const invoiceId = req.params.id;

    const response = await fetch(`https://api.xendit.co/v2/invoices/${invoiceId}`, {
      method: "GET",
      headers: {
        Authorization: "Basic " + Buffer.from(XENDIT_API_KEY + ":").toString("base64"),
        "Content-Type": "application/json"
      }
    });

    const result = await response.json();

    // If paid, move pending → reservations
    if (result.status === "PAID") {
      const slotId = result.description.split(" ")[2]; // "Reservation for slot1"
      const pendingSnap = await db.ref(`/pending/${slotId}`).get();
      if (pendingSnap.exists()) {
        const data = pendingSnap.val();
        await db.ref(`/reservations/${slotId}`).set(data);
        await db.ref(`/${slotId}`).update({ status: "Reserved", reserved: true });
        await db.ref(`/pending/${slotId}`).remove();
      }
    }

    res.json(result);
  } catch (error) {
    console.error("❌ Error checking invoice:", error);
    res.status(500).json({ error: "Failed to check invoice" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ IntelliPark backend running on port ${PORT}`);
});
