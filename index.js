// index.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

// Load environment variables from .env
require("dotenv").config();

const app = express();
app.use(cors({
  origin: [
    "http://localhost:5500",  // for local dev
    "https://intellipark2025-327e9.web.app" // your Firebase frontend
  ]
}));
app.use(bodyParser.json());

// Firebase Admin setup
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://intellipark2025-327e9-default-rtdb.firebaseio.com"
});
const db = admin.database();

// Health check
app.get("/", (req, res) => {
  res.send("✅ IntelliPark backend running");
});

// Create invoice
app.post("/api/create-invoice", async (req, res) => {
  try {
    const { name, email, plate, vehicle, time, slot } = req.body;
    const timestamp = new Date().toISOString();

    // 1. Call Xendit API to generate invoice
    const response = await fetch("https://api.xendit.co/v2/invoices", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(process.env.XENDIT_SECRET_KEY + ":").toString("base64"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        external_id: `resv-${Date.now()}`,
        amount: 50,
        currency: "PHP",
        description: `Reservation for ${slot}`,
        payer_email: email,
        success_redirect_url: `https://intellipark2025-327e9.web.app/confirmation.html?slot=${slot}&name=${encodeURIComponent(name)}&plate=${encodeURIComponent(plate)}&vehicle=${vehicle}&time=${time}&timestamp=${encodeURIComponent(timestamp)}&email=${encodeURIComponent(email)}`
      })
    });

    const invoice = await response.json();
    if (invoice.error_code) {
      return res.status(400).json(invoice);
    }

    res.json(invoice);
  } catch (err) {
    console.error("❌ Error creating invoice:", err);
    res.status(500).json({ error: "Failed to create invoice" });
  }
});

// Webhook for payment confirmation
app.post("/api/xendit-webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("🔔 Webhook received:", event);

    if (event.status === "PAID") {
      const metadata = event.external_id; // resv-xxxxx
      const slot = event.description.split(" ")[2]; // extract slot

      // Update Firebase
      await db.ref(`/reservations/${slot}`).set({
        name: event.payer_name || "Unknown",
        email: event.payer_email,
        plate: "N/A",
        vehicle: "N/A",
        time: new Date().toLocaleTimeString(),
        timestamp: new Date().toISOString(),
        status: "Paid"
      });

      await db.ref(`/${slot}`).update({ status: "Reserved", reserved: true });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.sendStatus(500);
  }
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ IntelliPark backend running on port ${PORT}`);
});
