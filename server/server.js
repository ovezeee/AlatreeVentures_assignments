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

// ✅ CORS middleware (improved to handle Vercel subdomains)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  console.log('Request origin:', origin);

  // Allow all Vercel app subdomains and localhost
  if (
    origin &&
    (origin.includes("localhost") || 
     origin.includes("vercel.app") ||
     origin.includes("127.0.0.1"))
  ) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (!origin) {
    // For requests without origin (like from Postman)
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Credentials", "true");
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

// In-memory storage for demo (replace with database in production)
let entries = [];

// ✅ API: Create Payment Intent
app.post("/api/create-payment-intent", async (req, res) => {
  try {
    const { category, entryType } = req.body;
    
    // Calculate fees based on category
    const categoryFees = {
      'business': 49,
      'creative': 49, 
      'technology': 99,
      'social-impact': 49
    };
    
    const entryFee = categoryFees[category] || 49;
    const stripeFeePercent = 0.029; // 2.9%
    const stripeFeeFixed = 0.30; // $0.30
    
    // Calculate in dollars (not cents)
    const stripeFee = (entryFee * stripeFeePercent) + stripeFeeFixed;
    const totalAmount = entryFee + stripeFee;
    
    // Stripe expects amount in cents
    const amountInCents = Math.round(totalAmount * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
    });

    res.json({ 
      clientSecret: paymentIntent.client_secret,
      entryFee,
      stripeFee,
      totalAmount
    });
  } catch (err) {
    console.error("Error creating payment intent:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ API: Submit Entry
app.post("/api/entries", upload.single("file"), (req, res) => {
  try {
    const {
      userId,
      category,
      entryType,
      title,
      description,
      textContent,
      videoUrl,
      paymentIntentId
    } = req.body;

    // Validate required fields
    if (!userId || !category || !entryType || !title || !paymentIntentId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Calculate fees
    const categoryFees = {
      'business': 49,
      'creative': 49,
      'technology': 99,
      'social-impact': 49
    };
    
    const entryFee = categoryFees[category] || 49;
    const stripeFeePercent = 0.029;
    const stripeFeeFixed = 0.30;
    const stripeFee = (entryFee * stripeFeePercent) + stripeFeeFixed;
    const totalAmount = entryFee + stripeFee;

    const newEntry = {
      _id: 'entry_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
      userId,
      category,
      entryType,
      title: title.trim(),
      description: description?.trim() || '',
      textContent: textContent?.trim() || '',
      videoUrl: videoUrl?.trim() || '',
      fileUrl: req.file ? `/uploads/${req.file.filename}` : '',
      fileName: req.file?.originalname || '',
      submissionDate: new Date().toISOString(),
      status: 'submitted',
      paymentIntentId,
      paymentStatus: 'succeeded',
      entryFee,
      stripeFee,
      totalAmount
    };

    entries.push(newEntry);
    console.log('Entry created:', newEntry._id);

    res.json({ 
      success: true, 
      entryId: newEntry._id,
      message: 'Entry submitted successfully'
    });
  } catch (err) {
    console.error('Error creating entry:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ API: Get user entries (MISSING ENDPOINT - ADDED)
app.get("/api/entries/:userId", (req, res) => {
  try {
    const { userId } = req.params;
    console.log('Fetching entries for userId:', userId);
    
    // Filter entries by userId
    const userEntries = entries.filter(entry => entry.userId === userId);
    console.log('Found entries:', userEntries.length);
    
    // Sort by submission date (newest first)
    userEntries.sort((a, b) => new Date(b.submissionDate) - new Date(a.submissionDate));
    
    res.json(userEntries);
  } catch (err) {
    console.error('Error fetching entries:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ API: Delete entry (MISSING ENDPOINT - ADDED)
app.delete("/api/entries/:entryId", (req, res) => {
  try {
    const { entryId } = req.params;
    const { userId } = req.body;
    
    console.log('Deleting entry:', entryId, 'for user:', userId);
    
    // Find the entry
    const entryIndex = entries.findIndex(entry => entry._id === entryId && entry.userId === userId);
    
    if (entryIndex === -1) {
      return res.status(404).json({ error: 'Entry not found or unauthorized' });
    }
    
    // Remove the entry
    const deletedEntry = entries.splice(entryIndex, 1)[0];
    
    // If there's a file, you might want to delete it too
    if (deletedEntry.fileUrl) {
      const filePath = path.join(process.cwd(), 'uploads', path.basename(deletedEntry.fileUrl));
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    
    console.log('Entry deleted:', entryId);
    res.json({ success: true, message: 'Entry deleted successfully' });
  } catch (err) {
    console.error('Error deleting entry:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ API: Create test entry (for debugging)
app.get("/api/create-test-entry/:userId", (req, res) => {
  try {
    const { userId } = req.params;
    
    const testEntry = {
      _id: 'entry_test_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
      userId,
      category: 'business',
      entryType: 'text',
      title: 'Test Entry - ' + new Date().toISOString(),
      description: 'This is a test entry created for debugging purposes.',
      textContent: 'This is test content for the entry. '.repeat(20), // ~100 words
      videoUrl: '',
      fileUrl: '',
      fileName: '',
      submissionDate: new Date().toISOString(),
      status: 'submitted',
      paymentIntentId: 'pi_test_' + Math.random().toString(36).substr(2, 9),
      paymentStatus: 'succeeded',
      entryFee: 49,
      stripeFee: 1.72,
      totalAmount: 50.72
    };

    entries.push(testEntry);
    console.log('Test entry created:', testEntry._id);

    res.json({ 
      success: true, 
      id: testEntry._id,
      message: 'Test entry created successfully'
    });
  } catch (err) {
    console.error('Error creating test entry:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ API: Create multiple test entries
app.get("/api/create-test-entries/:userId", (req, res) => {
  try {
    const { userId } = req.params;
    const testEntries = [];
    
    const categories = ['business', 'creative', 'technology', 'social-impact'];
    const entryTypes = ['text', 'pitch-deck', 'video'];
    const statuses = ['submitted', 'under-review', 'finalist', 'winner', 'rejected'];
    
    for (let i = 0; i < 5; i++) {
      const category = categories[i % categories.length];
      const entryType = entryTypes[i % entryTypes.length];
      const status = statuses[i % statuses.length];
      
      const entryFee = category === 'technology' ? 99 : 49;
      const stripeFee = (entryFee * 0.029) + 0.30;
      const totalAmount = entryFee + stripeFee;
      
      const testEntry = {
        _id: 'entry_test_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
        userId,
        category,
        entryType,
        title: `Test ${category.charAt(0).toUpperCase() + category.slice(1)} Entry #${i + 1}`,
        description: `This is a test ${entryType} entry for the ${category} category.`,
        textContent: entryType === 'text' ? 'This is test content. '.repeat(30) : '',
        videoUrl: entryType === 'video' ? 'https://youtube.com/watch?v=dQw4w9WgXcQ' : '',
        fileUrl: entryType === 'pitch-deck' ? '/uploads/test-pitch.pdf' : '',
        fileName: entryType === 'pitch-deck' ? 'test-pitch.pdf' : '',
        submissionDate: new Date(Date.now() - (i * 24 * 60 * 60 * 1000)).toISOString(),
        status,
        paymentIntentId: 'pi_test_' + Math.random().toString(36).substr(2, 9),
        paymentStatus: 'succeeded',
        entryFee,
        stripeFee: Math.round(stripeFee * 100) / 100,
        totalAmount: Math.round(totalAmount * 100) / 100
      };

      entries.push(testEntry);
      testEntries.push(testEntry);
    }
    
    console.log('Multiple test entries created:', testEntries.length);

    res.json({ 
      success: true, 
      entries: testEntries,
      message: `${testEntries.length} test entries created successfully`
    });
  } catch (err) {
    console.error('Error creating test entries:', err);
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
