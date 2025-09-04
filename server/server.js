import express from "express";
import bodyParser from "body-parser";
import multer from "multer";
import path from "path";
import fs from "fs";
import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ✅ File upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

// ✅ CORS middleware (dynamic for localhost + vercel.app)
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (
    origin &&
    (origin.includes("localhost") || origin.includes("vercel.app"))
  ) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, PATCH, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-Requested-With, Content-Type, Authorization, Stripe-Signature"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  next();
});

// ✅ Stripe webhook BEFORE express.json()
app.post(
  "/api/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle successful payment
    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object;
      console.log("💰 Payment succeeded:", paymentIntent.id);
    }

    res.json({ received: true });
  }
);

// ✅ Apply JSON parsers AFTER webhook
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ✅ API: Create Payment Intent
app.post("/api/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      automatic_payment_methods: { enabled: true },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error("Error creating payment intent:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ API: File upload
app.post("/api/upload", upload.single("file"), (req, res) => {
  res.json({ file: req.file });
});

// ✅ API: Test route
app.get("/api/hello", (req, res) => {
  res.json({ message: "Hello from backend 🚀" });
});

// ✅ Serve uploads folder
app.use("/uploads", express.static(uploadsDir));

// ✅ Start server in dev (Vercel will handle prod)
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}

export default app;
