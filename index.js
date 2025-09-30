const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fetch = require("node-fetch");
const admin = require("firebase-admin");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 8080;

// ✅ Allow ALL origins for now (CORS fix)
app.use(cors());
app.use(bodyParser.json());

// --- Initialize Firebase ---
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://intellipark2025-327e9-default-rtdb.firebaseio.com"
});

const db = admin.database();

// --- Xendit Keys ---
const XENDIT_SECRET_KEY = process.env.XENDIT_SECRET_KEY;

// --- API: Create Invoice ---
app.post("/api/create-invoice", async (req, res) => {
  try {
    const { slotId, name, email, plate, vehicle, time, timestamp } = req.body;

    if (!email || !slotId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const response = await fetch("https://api.xendit.co/v2/invoices", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(XENDIT_SECRET_KEY + ":").toString("base64"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        external_id: `resv-${Date.now()}`,
        amount: 50,
        currency: "PHP",
        description: `Reservation for ${slotId}`,
        payer_email: email,
        success_redirect_url: `https://intellipark2025-327e9.web.app/confirmation.html?slot=${slotId}&name=${encodeURIComponent(
          name
        )}&plate=${encodeURIComponent(plate)}&vehicle=${vehicle}&time=${time}&timestamp=${encodeURIComponent(
          timestamp
        )}&email=${encodeURIComponent(email)}&should_redirect_top=true`
      })
    });

    const result = await response.json();

    if (result.error) {
      console.error("Xendit API error:", result);
      return res.status(500).json({ error: "Failed to create invoice", details: result });
    }

    res.json(result);
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Test route ---
app.get("/", (req, res) => {
  res.send("✅ IntelliPark backend is running.");
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`✅ IntelliPark backend running on port ${PORT}`);
});
