// Updated: 2025-10-28 - Fixed plate number storage issue + supports 10 slots with zero-padding
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

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

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});
const db = admin.database();

const pendingReservations = new Map();

app.get("/", (req, res) => {
  res.send("✅ IntelliPark backend running");
});

// ✅ UPDATED: Now accepts dynamic amount based on vehicle type
app.post("/api/create-invoice", async (req, res) => {
  try {
    console.log("📥 Received request body:", JSON.stringify(req.body, null, 2));
    
    const { name, email, plate, vehicle, time, slot, type, amount } = req.body;
    const isWalkin = type === 'walk-in';
    
    console.log(`📋 Request type: ${isWalkin ? 'WALK-IN' : 'WEBSITE BOOKING'}`);
    console.log(`🚗 Vehicle: ${vehicle}, Amount: ₱${amount}`);

    // Validation
    if (!slot) return res.status(400).json({ error: "Missing slot parameter" });
    if (!email) return res.status(400).json({ error: "Missing email parameter" });
    if (!plate) return res.status(400).json({ error: "Missing plate parameter" });
    if (!vehicle) return res.status(400).json({ error: "Missing vehicle parameter" });
    if (!amount) return res.status(400).json({ error: "Missing amount parameter" });
    if (!isWalkin && !time) return res.status(400).json({ error: "Missing time parameter" });
    if (!isWalkin && !name) return res.status(400).json({ error: "Missing name parameter" });

    // ✅ Validate amount based on vehicle type
    const expectedAmount = vehicle === 'Motorcycle' ? 30 : 50;
    if (amount !== expectedAmount) {
      console.log(`⚠️ Amount mismatch: Expected ₱${expectedAmount} for ${vehicle}, got ₱${amount}`);
      return res.status(400).json({ error: `Invalid amount for ${vehicle}. Expected ₱${expectedAmount}` });
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    // Plate validation
    const plateRegex = /^[A-Za-z]{3}[0-9]{3}$/;
    if (!plateRegex.test(plate)) {
      return res.status(400).json({ error: "Plate number must be in format ABC123 (3 letters + 3 digits)" });
    }

    // Check slot availability
    const slotSnapshot = await db.ref(`/${slot}/status`).once('value');
    const slotStatus = slotSnapshot.val();
    
    if (!isWalkin && slotStatus !== 'Available') {
      console.log(`❌ Slot ${slot} is ${slotStatus}, not available for website booking`);
      return res.status(400).json({ error: `Slot ${slot} is no longer available` });
    }
    
    if (isWalkin && slotStatus === 'Occupied') {
      console.log(`❌ Slot ${slot} is Occupied`);
      return res.status(400).json({ error: `Slot ${slot} is currently occupied` });
    }
    
    if (isWalkin && slotStatus === 'Reserved') {
      const existingReservation = await db.ref(`/reservations/${slot}`).once('value');
      const reservation = existingReservation.val();
      
      if (reservation && reservation.status === 'Paid') {
        console.log(`❌ Slot ${slot} has a paid reservation`);
        return res.status(400).json({ error: `Slot ${slot} is already reserved and paid` });
      }
      
      if (reservation && reservation.status === 'Pending') {
        console.log(`⚠️ Overriding pending reservation for ${slot}`);
        await db.ref(`/reservations/${slot}`).remove();
      }
    }
    
    console.log(`✅ Slot ${slot} is available for ${isWalkin ? 'walk-in' : 'booking'}`);

    const timestamp = new Date().toISOString();
    const externalId = isWalkin ? `WALKIN_${slot}_${Date.now()}` : `WEBSITE_${slot}_${Date.now()}`;
    
    console.log(`✅ Validation passed. Creating invoice for ${email}, slot ${slot}`);
    console.log(`📝 External ID: ${externalId}`);
    console.log(`💰 Amount: ₱${amount} (${vehicle})`);

    // Store in memory
    const pendingData = isWalkin 
      ? { slot, email, plate, vehicle, amount, timestamp, type: 'walk-in' }
      : { slot, name, email, plate, vehicle, amount, time, timestamp, type: 'website-booking' };

    pendingReservations.set(externalId, pendingData);
    console.log(`💾 Stored pending ${isWalkin ? 'walk-in' : 'website booking'}: ${externalId}`);

    // ✅ CREATE INITIAL RESERVATION IN FIREBASE WITH DYNAMIC AMOUNT
    const initialReservation = isWalkin ? {
      email: email,
      plate: plate,
      vehicle: vehicle,
      slot: slot,
      status: 'Pending',
      amount: amount,
      timestamp: timestamp,
      reservedVia: 'Kiosk',
      exitTime: null,
      externalId: externalId,
      type: 'walk-in'
    } : {
      name: name,
      email: email,
      plate: plate,
      vehicle: vehicle,
      slot: slot,
      status: 'Pending',
      amount: amount,
      timestamp: timestamp,
      reservedVia: 'Website',
      exitTime: null,
      bookingTime: time,
      externalId: externalId,
      invoiceCreated: timestamp
    };

    await db.ref(`/reservations/${slot}`).set(initialReservation);
    console.log(`✅ Initial reservation created in Firebase: ${slot} (Amount: ₱${amount})`);

    // ✅ FIXED: Update slot status with COMPLETE data (including plate, email, time)
    await db.ref(`/${slot}`).update({ 
      status: 'Reserved', 
      reserved: true,
      reservedBy: isWalkin ? `Walk-in ${plate}` : name,
      reservationType: isWalkin ? 'Kiosk' : 'Website',
      vehicleType: vehicle,
      // ✅ ADDED: Store all booking details in slot object
      name: isWalkin ? `Walk-in ${plate}` : name,
      email: email,
      plate: plate,
      vehicle: vehicle,
      time: time || null,
      bookedAt: timestamp,
      amount: amount
    });
    console.log(`✅ Slot ${slot} marked as Reserved with complete booking data`);

    // Create Xendit invoice URLs
    const successUrl = isWalkin
      ? `https://intellipark-kiosk.web.app/payment-success.html?slot=${slot}&plate=${encodeURIComponent(plate)}&vehicle=${vehicle}`
      : `https://intellipark2025-327e9.web.app/confirmation.html?slot=${slot}&name=${encodeURIComponent(name)}&plate=${encodeURIComponent(plate)}&vehicle=${vehicle}&time=${time}&timestamp=${encodeURIComponent(timestamp)}&email=${encodeURIComponent(email)}`;

    const failureUrl = isWalkin
      ? `https://intellipark-kiosk.web.app/payment-failed.html`
      : `https://intellipark2025-327e9.web.app/payment-failed.html?slot=${slot}`;

    // ✅ Create Xendit invoice with dynamic amount
    const xenditPayload = {
      external_id: externalId,
      amount: amount,
      currency: "PHP",
      description: isWalkin 
        ? `Walk-in Parking (${vehicle}) - ${slot}` 
        : `Website Reservation (${vehicle}) - ${slot}`,
      payer_email: email,
      success_redirect_url: successUrl,
      failure_redirect_url: failureUrl,
      invoice_duration: 1800
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
      pendingReservations.delete(externalId);
      
      // Rollback reservation
      await db.ref(`/reservations/${slot}`).remove();
      await db.ref(`/${slot}`).update({ 
        status: 'Available', 
        reserved: false,
        name: "",
        email: "",
        plate: "",
        vehicle: "",
        time: "",
        bookedAt: ""
      });
      console.log(`🔄 Rolled back reservation for ${slot}`);
      
      return res.status(400).json({ error: "Xendit API error", details: invoice.message || invoice.error_code });
    }

    console.log("✅ Invoice created successfully:", invoice.id);
    
    res.json({
      success: true,
      invoiceUrl: invoice.invoice_url,
      externalId: externalId,
      amount: amount,
      vehicle: vehicle,
      invoice: invoice
    });

  } catch (err) {
    console.error("❌ Error creating invoice:", err.message);
    console.error("Stack trace:", err.stack);
    res.status(500).json({ error: "Failed to create invoice", details: err.message });
  }
});

// ✅ Webhook UPDATES existing reservation from Pending to Paid
app.post("/api/xendit-webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("🔔 Webhook received:", JSON.stringify(event, null, 2));

    if (event.status === "PAID") {
      const externalId = event.external_id;
      const reservationData = pendingReservations.get(externalId);
      
      if (!reservationData) {
        console.error("❌ No pending reservation found for:", externalId);
        return res.sendStatus(200);
      }

      const { slot, email, plate, vehicle, timestamp, type } = reservationData;
      const amount = event.amount;
      const invoiceId = event.id;
      const isWalkin = type === 'walk-in';

      console.log(`📍 Processing payment for slot: ${slot} (${type})`);
      console.log("👤 Customer details:", { email, plate, vehicle });

      await db.ref(`/reservations/${slot}`).update({
        status: "Paid",
        amount: amount,
        invoiceId: invoiceId,
        paymentTime: new Date().toISOString(),
        paymentConfirmed: true
      });
      
      console.log(`✅ Payment confirmed for ${slot} - ${type}`);

      await db.ref(`/${slot}`).update({ 
        status: "Reserved", 
        reserved: true,
        paymentStatus: 'Paid'
      });
      
      pendingReservations.delete(externalId);
      console.log(`✅ Payment processed successfully for ${externalId}`);
    }

    if (event.status === "EXPIRED" || event.status === "FAILED") {
      const externalId = event.external_id;
      const reservationData = pendingReservations.get(externalId);
      
      if (reservationData && !reservationData.type.includes('walk-in')) {
        const { slot } = reservationData;
        
        await db.ref(`/reservations/${slot}`).update({
          status: "Cancelled",
          cancelReason: event.status === "EXPIRED" ? "Payment timeout" : "Payment failed"
        });
        
        await db.ref(`/${slot}`).update({ 
          status: "Available", 
          reserved: false,
          name: "",
          email: "",
          plate: "",
          vehicle: "",
          time: "",
          bookedAt: ""
        });
        
        console.log(`🔄 Released slot ${slot} due to ${event.status}`);
        pendingReservations.delete(externalId);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.sendStatus(500);
  }
});

// ✅ Exit endpoint (called by exit kiosk)
app.post("/api/exit", async (req, res) => {
  try {
    const { slot, plate, exitTime, ticketId } = req.body;
    
    console.log(`🚪 Exit request - Slot: ${slot}, Plate: ${plate}, Ticket: ${ticketId || 'N/A'}`);

    if (!slot || !plate) {
      return res.status(400).json({ error: "Missing slot or plate" });
    }

    // ✅ Verify ticket if provided (from QR code exit)
    if (ticketId) {
      const ticketSnapshot = await db.ref(`/tickets/${ticketId}`).once('value');
      
      if (!ticketSnapshot.exists()) {
        console.error("❌ Invalid ticket");
        return res.status(404).json({ error: "Invalid ticket" });
      }

      const ticketData = ticketSnapshot.val();
      console.log('📦 Ticket data:', JSON.stringify(ticketData));
      
      if (ticketData.used) {
        console.error("❌ Ticket already used");
        return res.status(403).json({ error: "Ticket already used" });
      }

      const ticketType = ticketData.type;
      console.log(`🎫 Ticket type: ${ticketType}`);

      if (ticketType === 'walkin') {
        console.log('💰 Walk-in ticket - checking payment status...');
        if (ticketData.status !== 'Paid') {
          console.error("❌ Walk-in ticket not paid");
          return res.status(403).json({ error: "Payment required" });
        }
        console.log('✅ Walk-in payment verified - gate can open');
      } else if (ticketType === 'reservation') {
        console.log('🚪 Reservation ticket - checking entrance verification...');
        if (!ticketData.entryVerified) {
          console.error("❌ Reservation not checked in at entrance");
          return res.status(403).json({ error: "Please check in at entrance first" });
        }
        console.log('✅ Reservation entry verified - gate can open');
      } else {
        console.log('⚠️ No ticket type - using smart detection...');
        
        if (ticketData.status === 'Paid' && !ticketData.entryVerified) {
          console.log('✅ Detected as walk-in (paid, no entry check)');
        } 
        else if (ticketData.entryVerified) {
          console.log('✅ Detected as reservation (entry verified)');
        } 
        else {
          console.error("❌ Ticket not verified");
          return res.status(403).json({ error: "Ticket not verified" });
        }
      }

      if (ticketData.slot !== slot || ticketData.plate !== plate) {
        console.error("❌ Ticket data mismatch");
        return res.status(403).json({ error: "Ticket data mismatch" });
      }

      console.log('✅ Ticket validated:', ticketId);
    }

    // Verify reservation exists
    const reservationSnapshot = await db.ref(`/reservations/${slot}`).once('value');
    
    if (!reservationSnapshot.exists()) {
      console.log(`❌ No reservation for slot: ${slot}`);
      return res.status(404).json({ error: "No reservation found" });
    }

    const reservation = reservationSnapshot.val();

    if (reservation.plate !== plate) {
      console.log(`❌ Plate mismatch: Expected ${reservation.plate}, got ${plate}`);
      return res.status(403).json({ error: "Plate mismatch" });
    }

    const exitTimestamp = exitTime || new Date().toISOString();
    
    // Update reservation with exit time
    await db.ref(`/reservations/${slot}`).update({
      exitTime: exitTimestamp,
      status: "Completed"
    });

    // Free the slot
    await db.ref(`/${slot}`).update({
      status: "Available",
      reserved: false,
      name: "",
      email: "",
      plate: "",
      vehicle: "",
      time: "",
      bookedAt: ""
    });

    // ✅ Mark ticket as used in Firebase (if provided)
    if (ticketId) {
      await db.ref(`/tickets/${ticketId}`).update({
        used: true,
        usedAt: exitTimestamp
      });
      console.log(`✅ Ticket marked as used: ${ticketId}`);
    }

    // Calculate duration
    const entryTime = new Date(reservation.timestamp);
    const exitTimeDate = new Date(exitTimestamp);
    const durationMs = exitTimeDate - entryTime;
    const durationMins = Math.floor(durationMs / 60000);
    const hours = Math.floor(durationMins / 60);
    const mins = durationMins % 60;

    console.log(`✅ Exit recorded - ${slot} - Duration: ${hours}h ${mins}m`);

    res.json({
      success: true,
      message: "Gate opened",
      exitTime: exitTimestamp,
      duration: `${hours}h ${mins}m`,
      slot: slot,
      plate: plate
    });

  } catch (error) {
    console.error("❌ Exit error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/verify-exit", async (req, res) => {
  try {
    const { plate } = req.body;
    
    console.log(`🔍 Verifying exit for plate: ${plate}`);

    if (!plate) {
      return res.status(400).json({ error: "Missing plate parameter" });
    }

    const reservationsSnapshot = await db.ref('/reservations').once('value');
    const reservations = reservationsSnapshot.val();

    if (!reservations) {
      return res.status(404).json({ error: "No active reservations found" });
    }

    let matchingSlot = null;
    let matchingReservation = null;

    for (const [slot, reservation] of Object.entries(reservations)) {
      if (reservation.plate === plate && reservation.status === "Paid") {
        matchingSlot = slot;
        matchingReservation = reservation;
        break;
      }
    }

    if (!matchingSlot) {
      return res.status(404).json({ error: "No active reservation found for this plate number" });
    }

    console.log(`✅ Found reservation: ${matchingSlot} for plate ${plate}`);

    res.json({
      success: true,
      slot: matchingSlot,
      reservation: matchingReservation,
      message: "Reservation verified"
    });

  } catch (error) {
    console.error("❌ Error verifying exit:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/booking/:externalId", async (req, res) => {
  try {
    const { externalId } = req.params;
    
    console.log(`🔍 Checking booking status for: ${externalId}`);

    const isWalkin = externalId.includes('WALKIN');
    const path = isWalkin ? `/walk-in-bookings/${externalId}` : `/reservations/${externalId}`;

    const snapshot = await db.ref(path).once('value');
    const booking = snapshot.val();

    if (!booking) {
      console.log(`❌ Booking not found: ${externalId}`);
      return res.status(404).json({ error: 'Booking not found' });
    }

    console.log(`✅ Booking found: ${externalId}`);
    res.json({ success: true, booking: booking });

  } catch (error) {
    console.error('❌ Error fetching booking:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ IntelliPark backend running on port ${PORT}`);
});
