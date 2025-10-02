const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const QRCode = require("qrcode");
require("dotenv").config();

const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();
const app = express();

app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 8080;

// Test route
app.get("/", (req, res) => {
  res.send("✅ IntelliPark backend running!");
});

// Create invoice (simplified version)
app.post("/api/create-invoice", async (req, res) => {
  try {
    const { slot, name, plate, vehicle, email, time } = req.body;

    if (!slot || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Simulate invoice creation (replace with real Xendit call)
    res.json({
      invoice_url: "https://checkout.xendit.co/web/1234567890",
      slot,
      name,
      plate,
      vehicle,
      email,
      time
    });
  } catch (error) {
    console.error("Error creating invoice:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Confirm payment and save reservation
app.post("/api/confirm-payment", async (req, res) => {
  try {
    const { slot, name, plate, vehicle, email, time } = req.body;

    if (!slot || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Generate QR code (encode slot + email for kiosk)
    const qrData = JSON.stringify({ slot, email });
    const qrImage = await QRCode.toDataURL(qrData);

    // Save reservation in Firebase
    await db.ref(`reservations/${slot}`).set({
      name,
      plate,
      vehicle,
      email,
      time,
      timestamp: Date.now(),
      status: "confirmed",
      qr: qrImage
    });

    // Also mark slot as reserved
    await db.ref(`${slot}/status`).set("reserved");

    res.json({ success: true, message: "Reservation confirmed and saved", qr: qrImage });
  } catch (error) {
    console.error("Error confirming reservation:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ IntelliPark backend running on port ${PORT}`);
});