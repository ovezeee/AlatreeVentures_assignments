const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Initialize Stripe with error checking
let stripe;
try {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('ERROR: STRIPE_SECRET_KEY not found in environment variables');
    console.log('Please add STRIPE_SECRET_KEY to your .env file');
    process.exit(1);
  }
  if (!process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
    console.error('ERROR: STRIPE_SECRET_KEY is not a test key. Please use a test key in test mode.');
    process.exit(1);
  }
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  console.log('✅ Stripe initialized successfully in test mode');
} catch (error) {
  console.error('ERROR: Failed to initialize Stripe:', error.message);
  process.exit(1);
}

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// For Vercel, we'll use memory storage instead of disk storage
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedTypes = {
    'application/pdf': '.pdf',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx'
  };
  if (allowedTypes[file.mimetype]) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only PDF and PPT files are allowed.'), false);
  }
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit
  fileFilter: fileFilter
});

// MongoDB Connection with error handling
const connectDB = async () => {
  try {
    const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/top216';
    await mongoose.connect(mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    console.error('ERROR: MongoDB connection failed:', error.message);
    console.log('Make sure MongoDB is running on your system');
    process.exit(1);
  }
};

// Only connect to DB if not already connected (important for serverless)
if (mongoose.connection.readyState === 0) {
  connectDB();
}

// Entry Schema - Modified to store file as base64 or external URL
const entrySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  category: { type: String, required: true, enum: ['business', 'creative', 'technology', 'social-impact'] },
  entryType: { type: String, required: true, enum: ['text', 'pitch-deck', 'video'] },
  title: { type: String, required: true, minlength: 5, maxlength: 100 },
  description: { type: String, maxlength: 1000 },
  textContent: {
    type: String,
    validate: {
      validator: function (v) {
        if (this.entryType === 'text') {
          const wordCount = v ? v.split(/\s+/).filter(word => word.length > 0).length : 0;
          return wordCount >= 100 && wordCount <= 2000;
        }
        return true;
      },
      message: 'Text entries must be between 100-2000 words'
    }
  },
  // Store file data directly in MongoDB for Vercel compatibility
  fileData: {
    type: String, // Base64 encoded file data
    validate: {
      validator: function (v) {
        if (this.entryType === 'pitch-deck') {
          return !!v;
        }
        return true;
      },
      message: 'File data required for pitch deck entries'
    }
  },
  fileName: { type: String }, // Original filename
  fileType: { type: String }, // File mimetype
  videoUrl: {
    type: String,
    validate: {
      validator: function (v) {
        if (this.entryType === 'video' && v) {
          const urlPattern = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|vimeo\.com)/i;
          return urlPattern.test(v);
        }
        return this.entryType !== 'video' || !!v;
      },
      message: 'Valid YouTube or Vimeo URL required for video entries'
    }
  },
  entryFee: { type: Number, required: true },
  stripeFee: { type: Number, required: true },
  totalAmount: { type: Number, required: true },
  paymentIntentId: { type: String, required: true },
  paymentStatus: { type: String, enum: ['pending', 'succeeded', 'failed'], default: 'pending' },
  submissionDate: { type: Date, default: Date.now },
  status: { type: String, enum: ['submitted', 'under-review', 'finalist', 'winner', 'rejected'], default: 'submitted' }
}, { timestamps: true });

const Entry = mongoose.model('Entry', entrySchema);

// Helper function to calculate fees
const calculateFees = (baseAmount) => {
  const stripeFee = Math.ceil(baseAmount * 0.04); // 4% fee, rounded up
  const totalAmount = baseAmount + stripeFee;
  return { stripeFee, totalAmount };
};

// Routes
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

app.get('/api/create-test-entry/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const entry = new Entry({
      userId,
      category: 'business',
      entryType: 'text',
      title: 'Sample Business Strategy Entry',
      description: 'A comprehensive business strategy for digital transformation in modern enterprises',
      textContent: 'This is a detailed business strategy...'.repeat(50), // Make it longer to meet word count
      entryFee: 49,
      stripeFee: 2,
      totalAmount: 51,
      paymentIntentId: 'pi_test_' + Date.now(),
      paymentStatus: 'succeeded'
    });
    await entry.save();
    console.log('Test entry created:', entry._id);
    res.json({ 
      message: 'Test entry created successfully', 
      id: entry._id,
      title: entry.title 
    });
  } catch (error) {
    console.error('Error creating test entry:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/create-payment-intent', async (req, res) => {
  try {
    console.log('Payment intent request received:', req.body);
    const { category, entryType } = req.body;
    if (!category || !entryType) {
      return res.status(400).json({ 
        error: 'Category and entryType are required',
        received: { category, entryType }
      });
    }
    const baseFees = { 'business': 49, 'creative': 49, 'technology': 99, 'social-impact': 49 };
    const entryFee = baseFees[category];
    if (!entryFee) {
      return res.status(400).json({ 
        error: 'Invalid category',
        validCategories: Object.keys(baseFees),
        received: category
      });
    }
    const { stripeFee, totalAmount } = calculateFees(entryFee);
    console.log('Creating payment intent with amount:', totalAmount * 100, 'cents');
    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmount * 100,
      currency: 'usd',
      metadata: { category, entryType, entryFee: entryFee.toString(), stripeFee: stripeFee.toString() }
    });
    console.log('Payment intent created successfully:', paymentIntent.id);
    res.json({ clientSecret: paymentIntent.client_secret, entryFee, stripeFee, totalAmount });
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ 
      error: 'Failed to create payment intent',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Modified entries endpoint to handle file uploads in memory
app.post('/api/entries', upload.single('file'), async (req, res) => {
  try {
    console.log('Entry submission received:', {
      body: req.body,
      file: req.file ? { filename: req.file.originalname, size: req.file.size } : null
    });
    const { userId, category, entryType, title, description, textContent, videoUrl, paymentIntentId } = req.body;
    
    // Validate required fields
    if (!userId || !category || !entryType || !title || !paymentIntentId) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['userId', 'category', 'entryType', 'title', 'paymentIntentId'],
        received: { userId, category, entryType, title, paymentIntentId }
      });
    }

    // Server-side file validation for pitch-deck
    if (entryType === 'pitch-deck') {
      if (!req.file) {
        return res.status(400).json({ error: 'File required for pitch-deck entries' });
      }
      const allowedTypes = [
        'application/pdf',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      ];
      if (!allowedTypes.includes(req.file.mimetype)) {
        return res.status(400).json({ error: 'Invalid file type. Only PDF, PPT, PPTX allowed.' });
      }
      if (req.file.size > 25 * 1024 * 1024) {
        return res.status(400).json({ error: 'File size exceeds 25MB limit.' });
      }
    }

    console.log('Verifying payment intent:', paymentIntentId);
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ 
        error: 'Payment not completed',
        paymentStatus: paymentIntent.status
      });
    }

    const entryFee = parseInt(paymentIntent.metadata.entryFee);
    const stripeFee = parseInt(paymentIntent.metadata.stripeFee);
    const totalAmount = entryFee + stripeFee;

    const entryData = {
      userId,
      category,
      entryType,
      title,
      description,
      entryFee,
      stripeFee,
      totalAmount,
      paymentIntentId,
      paymentStatus: 'succeeded'
    };

    if (entryType === 'text') {
      entryData.textContent = textContent;
    } else if (entryType === 'pitch-deck' && req.file) {
      // Store file as base64 in MongoDB for Vercel compatibility
      entryData.fileData = req.file.buffer.toString('base64');
      entryData.fileName = req.file.originalname;
      entryData.fileType = req.file.mimetype;
    } else if (entryType === 'video') {
      entryData.videoUrl = videoUrl;
    }

    console.log('Creating entry with data:', { ...entryData, fileData: entryData.fileData ? '[BASE64_DATA]' : undefined });
    const entry = new Entry(entryData);
    await entry.save();
    console.log('Entry created successfully:', entry._id);
    
    res.status(201).json({ message: 'Entry submitted successfully', entryId: entry._id });
  } catch (error) {
    console.error('Error submitting entry:', error);
    res.status(500).json({ 
      error: 'Failed to submit entry',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Add endpoint to download files
app.get('/api/entries/:entryId/download', async (req, res) => {
  try {
    const entry = await Entry.findById(req.params.entryId);
    if (!entry || !entry.fileData) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const fileBuffer = Buffer.from(entry.fileData, 'base64');
    
    res.set({
      'Content-Type': entry.fileType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${entry.fileName || 'file'}"`,
      'Content-Length': fileBuffer.length
    });
    
    res.send(fileBuffer);
  } catch (error) {
    console.error('Error downloading file:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

app.get('/api/entries/:userId', async (req, res) => {
  try {
    console.log('Fetching entries for user:', req.params.userId);
    const entries = await Entry.find({ userId: req.params.userId })
      .select('-fileData') // Don't return file data in list view
      .sort({ createdAt: -1 });
    console.log(`Found ${entries.length} entries for user:`, req.params.userId);
    res.json(entries);
  } catch (error) {
    console.error('Error fetching entries:', error);
    res.status(500).json({ 
      error: 'Failed to fetch entries',
      message: error.message
    });
  }
});

app.get('/api/entry/:id', async (req, res) => {
  try {
    const entry = await Entry.findById(req.params.id).select('-fileData'); // Don't return file data
    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }
    res.json(entry);
  } catch (error) {
    console.error('Error fetching entry:', error);
    res.status(500).json({ 
      error: 'Failed to fetch entry',
      message: error.message
    });
  }
});

app.delete('/api/entries/:id', async (req, res) => {
  try {
    const entryId = req.params.id;
    const { userId } = req.body;
    console.log('Deleting entry:', entryId, 'for user:', userId);
    
    const entry = await Entry.findById(entryId);
    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }
    
    if (entry.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized to delete this entry' });
    }
    
    await Entry.findByIdAndDelete(entryId);
    console.log('Entry deleted successfully:', entryId);
    
    res.json({ message: 'Entry deleted successfully' });
  } catch (error) {
    console.error('Error deleting entry:', error);
    res.status(500).json({ 
      error: 'Failed to delete entry',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`Webhook signature verification failed.`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'payment_intent.payment_failed') {
    const paymentIntent = event.data.object;
    Entry.findOneAndUpdate(
      { paymentIntentId: paymentIntent.id },
      { paymentStatus: 'failed' }
    ).exec();
  }
  res.json({ received: true });
});

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: error.message,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
  });
});

const PORT = process.env.PORT || 5000;

// For local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
    console.log(`🧪 Create test entry: http://localhost:${PORT}/api/create-test-entry/user_test123`);
  });
}

// Export for Vercel
module.exports = app;
