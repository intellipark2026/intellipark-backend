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
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "https://intellipark2025-327e9.web.app"
  ]
}));
app.use(bodyParser.json());

// Firebase Admin setup
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});
const db = admin.database();

// Health check
app.get("/", (req, res) => {
  res.send("✅ IntelliPark backend running");
});

// Create invoice
app.post("/api/create-invoice", async (req, res) => {
  try {
    console.log("📥 Received request body:", JSON.stringify(req.body, null, 2));
    
    const { name, email, plate, vehicle, time, slot } = req.body;

    // Detailed validation with specific error messages
    if (!slot) {
      console.error("❌ Missing slot parameter");
      return res.status(400).json({ error: "Missing slot parameter" });
    }
    
    if (!email) {
      console.error("❌ Missing email parameter");
      return res.status(400).json({ error: "Missing email parameter" });
    }
    
    if (!name) {
      console.error("❌ Missing name parameter");
      return res.status(400).json({ error: "Missing name parameter" });
    }
    
    if (!plate) {
      console.error("❌ Missing plate parameter");
      return res.status(400).json({ error: "Missing plate parameter" });
    }
    
    if (!vehicle) {
      console.error("❌ Missing vehicle parameter");
      return res.status(400).json({ error: "Missing vehicle parameter" });
    }
    
    if (!time) {
      console.error("❌ Missing time parameter");
      return res.status(400).json({ error: "Missing time parameter" });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      console.error("❌ Invalid email format:", email);
      return res.status(400).json({ error: "Invalid email format" });
    }

    // Validate plate format (ABC123)
    const plateRegex = /^[A-Za-z]{3}[0-9]{3}$/;
    if (!plateRegex.test(plate)) {
      console.error("❌ Invalid plate format:", plate);
      return res.status(400).json({ error: "Plate number must be in format ABC123 (3 letters + 3 digits)" });
    }

    const timestamp = new Date().toISOString();
    console.log(`✅ Validation passed. Creating invoice for ${email}, slot ${slot}`);

    // Call Xendit API to generate invoice
    const xenditPayload = {
      external_id: `resv-${Date.now()}`,
      amount: 50,
      currency: "PHP",
      description: `Reservation for ${slot}`,
      payer_email: email,
      success_redirect_url: `https://intellipark2025-327e9.web.app/confirmation.html?slot=${slot}&name=${encodeURIComponent(name)}&plate=${encodeURIComponent(plate)}&vehicle=${vehicle}&time=${time}&timestamp=${encodeURIComponent(timestamp)}&email=${encodeURIComponent(email)}`
    };

    console.log("📤 Sending to Xendit:", JSON.stringify(xenditPayload, null, 2));

    const response = await fetch("https://api.xendit.co/v2/invoices", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(process.env.XENDIT_SECRET_KEY + ":").toString("base64"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(xenditPayload)
    });

    const invoice = await response.json();
    console.log("📥 Xendit response:", JSON.stringify(invoice, null, 2));

    if (invoice.error_code) {
      console.error("❌ Xendit error:", invoice);
      return res.status(400).json({ 
        error: "Xendit API error", 
        details: invoice.message || invoice.error_code 
      });
    }

    console.log("✅ Invoice created successfully:", invoice.id);
    res.json(invoice);

  } catch (err) {
    console.error("❌ Error creating invoice:", err.message);
    console.error("Stack trace:", err.stack);
    res.status(500).json({ 
      error: "Failed to create invoice", 
      details: err.message 
    });
  }
});

// Webhook for payment confirmation
app.post("/api/xendit-webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("🔔 Webhook received:", JSON.stringify(event, null, 2));

    if (event.status === "PAID") {
      // Extract slot from external_id
      const slot = event.external_id.split("_")[0];
      const email = event.payer_email || "N/A";
      const name = event.description || "N/A";
      const amount = event.amount;
      const invoiceId = event.id;

      console.log("📍 Processing payment for slot:", slot);

      // Update Firebase
      await db.ref(`/reservations/${slot}`).set({
        name: name,
        email: email,
        plate: "N/A",
        vehicle: "N/A",
        time: new Date().toLocaleTimeString(),
        timestamp: new Date().toISOString(),
        status: "Paid",
        amount: amount,
        invoiceId: invoiceId
      });

      await db.ref(`/${slot}`).update({ 
        status: "Reserved", 
        reserved: true 
      });

      console.log(`✅ Reservation confirmed for ${slot}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.sendStatus(500);
  }
});


// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ IntelliPark backend running on port ${PORT}`);
});
