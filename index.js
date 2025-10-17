// Updated: 2025-10-17 - Added walk-in payment support for kiosk
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
    "https://intellipark2025-327e9.web.app",
    "https://intellipark-kiosk.web.app",
    "https://intellipark-kiosk.firebaseapp.com"
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

// ✅ Store pending reservations temporarily
const pendingReservations = new Map();

// Health check
app.get("/", (req, res) => {
  res.send("✅ IntelliPark backend running");
});

// UPDATED: Create invoice - handles both reservation and walk-in
app.post("/api/create-invoice", async (req, res) => {
  try {
    console.log("📥 Received request body:", JSON.stringify(req.body, null, 2));
    
    const { name, email, plate, vehicle, time, slot, type } = req.body;

    // Determine if this is walk-in or reservation
    const isWalkin = type === 'walk-in';
    
    console.log(`📋 Request type: ${isWalkin ? 'WALK-IN' : 'RESERVATION'}`);

    // Detailed validation with specific error messages
    if (!slot) {
      console.error("❌ Missing slot parameter");
      return res.status(400).json({ error: "Missing slot parameter" });
    }
    
    if (!email) {
      console.error("❌ Missing email parameter");
      return res.status(400).json({ error: "Missing email parameter" });
    }
    
    if (!plate) {
      console.error("❌ Missing plate parameter");
      return res.status(400).json({ error: "Missing plate parameter" });
    }
    
    if (!vehicle) {
      console.error("❌ Missing vehicle parameter");
      return res.status(400).json({ error: "Missing vehicle parameter" });
    }

    // Time is required only for reservations
    if (!isWalkin && !time) {
      console.error("❌ Missing time parameter for reservation");
      return res.status(400).json({ error: "Missing time parameter" });
    }

    // Name is required only for reservations
    if (!isWalkin && !name) {
      console.error("❌ Missing name parameter for reservation");
      return res.status(400).json({ error: "Missing name parameter" });
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
    
    // Generate different external ID format based on type
    const externalId = isWalkin 
      ? `WALKIN_${slot}_${Date.now()}`
      : `${slot}_${Date.now()}`;
    
    console.log(`✅ Validation passed. Creating invoice for ${email}, slot ${slot}`);

    // ✅ Store reservation/walk-in data temporarily (will be completed on payment)
    const pendingData = isWalkin 
      ? {
          slot,
          email,
          plate,
          vehicle,
          timestamp,
          type: 'walk-in'
        }
      : {
          slot,
          name,
          email,
          plate,
          vehicle,
          time,
          timestamp,
          type: 'reservation'
        };

    pendingReservations.set(externalId, pendingData);

    console.log(`💾 Stored pending ${isWalkin ? 'walk-in' : 'reservation'}: ${externalId}`);

    // Determine redirect URLs based on type
    const successUrl = isWalkin
      ? `https://intellipark-kiosk.web.app/payment-success.html?slot=${slot}&plate=${encodeURIComponent(plate)}&vehicle=${vehicle}`
      : `https://intellipark2025-327e9.web.app/confirmation.html?slot=${slot}&name=${encodeURIComponent(name)}&plate=${encodeURIComponent(plate)}&vehicle=${vehicle}&time=${time}&timestamp=${encodeURIComponent(timestamp)}&email=${encodeURIComponent(email)}`;

    const failureUrl = isWalkin
      ? `https://intellipark-kiosk.web.app/payment-failed.html`
      : `https://intellipark2025-327e9.web.app/payment-failed.html`;

    // Call Xendit API to generate invoice
    const xenditPayload = {
      external_id: externalId,
      amount: 50,
      currency: "PHP",
      description: isWalkin 
        ? `Walk-in Parking - ${slot}` 
        : `Reservation for ${slot}`,
      payer_email: email,
      success_redirect_url: successUrl,
      failure_redirect_url: failureUrl
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
      pendingReservations.delete(externalId); // Clean up
      return res.status(400).json({ 
        error: "Xendit API error", 
        details: invoice.message || invoice.error_code 
      });
    }

    console.log("✅ Invoice created successfully:", invoice.id);
    
    // Return response with success flag and invoice URL
    res.json({
      success: true,
      invoiceUrl: invoice.invoice_url,
      externalId: externalId,
      invoice: invoice
    });

  } catch (err) {
    console.error("❌ Error creating invoice:", err.message);
    console.error("Stack trace:", err.stack);
    res.status(500).json({ 
      error: "Failed to create invoice", 
      details: err.message 
    });
  }
});

// UPDATED: Webhook for payment confirmation - handles both types
app.post("/api/xendit-webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("🔔 Webhook received:", JSON.stringify(event, null, 2));

    if (event.status === "PAID") {
      const externalId = event.external_id;
      
      // ✅ Retrieve the stored reservation data
      const reservationData = pendingReservations.get(externalId);
      
      if (!reservationData) {
        console.error("❌ No pending reservation found for:", externalId);
        return res.sendStatus(404);
      }

      const { slot, email, plate, vehicle, timestamp, type } = reservationData;
      const amount = event.amount;
      const invoiceId = event.id;

      const isWalkin = type === 'walk-in';

      console.log(`📍 Processing payment for slot: ${slot} (${isWalkin ? 'WALK-IN' : 'RESERVATION'})`);
      console.log("👤 Customer details:", { email, plate, vehicle });

      if (isWalkin) {
        // ✅ Save walk-in booking to separate path in Firebase
        await db.ref(`/walk-in-bookings/${externalId}`).set({
          slot: slot,
          email: email,
          plate: plate,
          vehicle: vehicle,
          timestamp: timestamp,
          status: "Paid",
          amount: amount,
          invoiceId: invoiceId,
          type: 'walk-in'
        });

        console.log(`✅ Walk-in booking confirmed for ${slot} - ${plate}`);

      } else {
        // ✅ Save reservation to original path (existing logic)
        const { name, time } = reservationData;
        
        await db.ref(`/reservations/${slot}`).set({
          name: name,
          email: email,
          plate: plate,
          vehicle: vehicle,
          time: time,
          timestamp: timestamp,
          status: "Paid",
          amount: amount,
          invoiceId: invoiceId,
          type: 'reservation'
        });

        console.log(`✅ Reservation confirmed for ${slot} - ${name} (${plate})`);
      }

      // ✅ Update slot status (both types)
      await db.ref(`/${slot}`).update({ 
        status: "Reserved", 
        reserved: true 
      });

      // ✅ Clean up pending reservation
      pendingReservations.delete(externalId);

      console.log(`✅ Payment processed successfully for ${externalId}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.sendStatus(500);
  }
});

// Get booking status (works for both types)
app.get("/api/booking/:externalId", async (req, res) => {
  try {
    const { externalId } = req.params;
    
    console.log(`🔍 Checking booking status for: ${externalId}`);

    // Check if it's walk-in or reservation
    const isWalkin = externalId.includes('WALKIN');
    const path = isWalkin 
      ? `/walk-in-bookings/${externalId}` 
      : `/reservations/${externalId}`;

    const snapshot = await db.ref(path).once('value');
    const booking = snapshot.val();

    if (!booking) {
      console.log(`❌ Booking not found: ${externalId}`);
      return res.status(404).json({ error: 'Booking not found' });
    }

    console.log(`✅ Booking found: ${externalId}`);
    res.json({
      success: true,
      booking: booking
    });

  } catch (error) {
    console.error('❌ Error fetching booking:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ IntelliPark backend running on port ${PORT}`);
});
