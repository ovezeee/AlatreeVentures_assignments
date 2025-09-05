const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Initialize Express app
const app = express();

// Environment variables - Vercel automatically loads these
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const MONGODB_URI = process.env.MONGODB_URI;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Initialize Stripe
let stripe;
try {
  if (!STRIPE_SECRET_KEY) {
    console.error('ERROR: STRIPE_SECRET_KEY not found');
    throw new Error('STRIPE_SECRET_KEY required');
  }
  stripe = require('stripe')(STRIPE_SECRET_KEY);
  console.log('✅ Stripe initialized');
} catch (error) {
  console.error('Failed to initialize Stripe:', error.message);
  // Don't exit in serverless - handle gracefully
}

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'https://your-domain.vercel.app'], // Add your frontend URLs
  credentials: true
}));

// Webhook route FIRST (needs raw body)
app.use('/api/webhook', express.raw({ type: 'application/json' }));

// JSON parsing for other routes
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// MongoDB connection - optimized for serverless
let cachedConnection = null;

const connectDB = async () => {
  if (cachedConnection && mongoose.connection.readyState === 1) {
    console.log('Using cached database connection');
    return cachedConnection;
  }

  try {
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI not found');
    }

    const opts = {
      bufferCommands: false, // Disable mongoose buffering
      bufferMaxEntries: 0, // Disable mongoose buffering
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000, // Keep this short for serverless
      socketTimeoutMS: 45000,
      maxPoolSize: 1, // Maintain up to 1 socket connection
      minPoolSize: 0, // Start with 0 connections
      maxIdleTimeMS: 30000, // Close connections after 30 seconds of inactivity
    };

    cachedConnection = await mongoose.connect(MONGODB_URI, opts);
    console.log('✅ MongoDB connected');
    return cachedConnection;
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    cachedConnection = null;
    throw error;
  }
};

// Entry Schema
const entrySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  category: { 
    type: String, 
    required: true, 
    enum: ['business', 'creative', 'technology', 'social-impact']
  },
  entryType: { 
    type: String, 
    required: true, 
    enum: ['text', 'pitch-deck', 'video']
  },
  title: { 
    type: String, 
    required: true, 
    minlength: 5,
    maxlength: 100
  },
  description: { 
    type: String, 
    maxlength: 1000
  },
  textContent: {
    type: String,
    validate: {
      validator: function (v) {
        if (this.entryType === 'text') {
          if (!v) return false;
          const wordCount = v.split(/\s+/).filter(word => word.length > 0).length;
          return wordCount >= 100 && wordCount <= 2000;
        }
        return true;
      },
      message: 'Text entries must be between 100-2000 words'
    }
  },
  fileUrl: { type: String },
  videoUrl: {
    type: String,
    validate: {
      validator: function (v) {
        if (this.entryType === 'video') {
          if (!v) return false;
          const urlPattern = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|vimeo\.com)/i;
          return urlPattern.test(v);
        }
        return true;
      },
      message: 'Valid YouTube or Vimeo URL required for video entries'
    }
  },
  entryFee: { type: Number, required: true, min: 0 },
  stripeFee: { type: Number, required: true, min: 0 },
  totalAmount: { type: Number, required: true, min: 0 },
  paymentIntentId: { type: String, required: true },
  paymentStatus: { 
    type: String, 
    enum: ['pending', 'succeeded', 'failed'], 
    default: 'pending' 
  },
  submissionDate: { type: Date, default: Date.now },
  status: { 
    type: String, 
    enum: ['submitted', 'under-review', 'finalist', 'winner', 'rejected'], 
    default: 'submitted' 
  }
}, { timestamps: true });

// Create model (only if not already compiled)
const Entry = mongoose.models.Entry || mongoose.model('Entry', entrySchema);

// In-memory storage for files in serverless (temporary)
// Note: Files won't persist between function calls
const fileStorage = new Map();

// Simple file upload handler for serverless
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF and PowerPoint files allowed.'), false);
    }
  }
});

// Helper functions
const calculateFees = (baseAmount) => {
  const stripeFee = Math.ceil(baseAmount * 0.04);
  const totalAmount = baseAmount + stripeFee;
  return { stripeFee, totalAmount };
};

const handleAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Routes
app.get('/api/health', handleAsync(async (req, res) => {
  try {
    await connectDB();
    const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    
    res.json({ 
      status: 'OK',
      message: 'Serverless function is running',
      timestamp: new Date().toISOString(),
      database: dbStatus,
      environment: process.env.VERCEL_ENV || 'development'
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      message: error.message
    });
  }
}));

app.post('/api/create-payment-intent', handleAsync(async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe not initialized' });
  }

  const { category, entryType } = req.body;
  
  if (!category || !entryType) {
    return res.status(400).json({ 
      error: 'Category and entryType are required',
      received: { category, entryType }
    });
  }
  
  const baseFees = { 
    'business': 49, 
    'creative': 49, 
    'technology': 99, 
    'social-impact': 49 
  };
  
  const entryFee = baseFees[category];
  
  if (!entryFee) {
    return res.status(400).json({ 
      error: 'Invalid category',
      validCategories: Object.keys(baseFees)
    });
  }
  
  const { stripeFee, totalAmount } = calculateFees(entryFee);
  
  const paymentIntent = await stripe.paymentIntents.create({
    amount: totalAmount * 100,
    currency: 'usd',
    automatic_payment_methods: { enabled: true },
    metadata: { 
      category, 
      entryType, 
      entryFee: entryFee.toString(), 
      stripeFee: stripeFee.toString() 
    }
  });
  
  res.json({ 
    clientSecret: paymentIntent.client_secret, 
    entryFee, 
    stripeFee, 
    totalAmount 
  });
}));

app.post('/api/entries', handleAsync(async (req, res) => {
  await connectDB();

  // Handle file upload
  const uploadSingle = upload.single('file');
  
  return new Promise((resolve, reject) => {
    uploadSingle(req, res, async (err) => {
      if (err) {
        console.error('Upload error:', err);
        return res.status(400).json({ error: err.message });
      }

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
        
        // Validation
        if (!userId || !category || !entryType || !title || !paymentIntentId) {
          return res.status(400).json({ 
            error: 'Missing required fields',
            required: ['userId', 'category', 'entryType', 'title', 'paymentIntentId']
          });
        }

        // Verify payment
        if (!stripe) {
          return res.status(500).json({ error: 'Payment verification unavailable' });
        }

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
          description: description || '',
          entryFee,
          stripeFee,
          totalAmount,
          paymentIntentId,
          paymentStatus: 'succeeded'
        };
        
        // Handle different entry types
        if (entryType === 'text') {
          if (!textContent) {
            return res.status(400).json({ error: 'Text content required' });
          }
          entryData.textContent = textContent;
        } else if (entryType === 'pitch-deck') {
          if (!req.file) {
            return res.status(400).json({ error: 'File required for pitch deck' });
          }
          // In serverless, you'd typically upload to cloud storage (AWS S3, etc.)
          // For now, we'll store a reference
          const fileId = Date.now() + '_' + req.file.originalname;
          fileStorage.set(fileId, req.file.buffer);
          entryData.fileUrl = `/api/files/${fileId}`;
        } else if (entryType === 'video') {
          if (!videoUrl) {
            return res.status(400).json({ error: 'Video URL required' });
          }
          entryData.videoUrl = videoUrl;
        }
        
        const entry = new Entry(entryData);
        const savedEntry = await entry.save();
        
        res.status(201).json({ 
          message: 'Entry submitted successfully', 
          entryId: savedEntry._id,
          entry: {
            id: savedEntry._id,
            title: savedEntry.title,
            category: savedEntry.category,
            entryType: savedEntry.entryType,
            status: savedEntry.status
          }
        });
        
        resolve();
      } catch (error) {
        console.error('Error creating entry:', error);
        res.status(500).json({ 
          error: 'Failed to submit entry',
          message: error.message
        });
        resolve();
      }
    });
  });
}));

app.get('/api/entries/:userId', handleAsync(async (req, res) => {
  await connectDB();
  
  const userId = req.params.userId;
  
  if (!userId || userId.length < 3) {
    return res.status(400).json({ error: 'Valid userId required' });
  }
  
  const entries = await Entry.find({ userId })
    .sort({ createdAt: -1 })
    .select('-__v');
  
  res.json(entries);
}));

app.get('/api/entry/:id', handleAsync(async (req, res) => {
  await connectDB();
  
  const entryId = req.params.id;
  
  if (!mongoose.Types.ObjectId.isValid(entryId)) {
    return res.status(400).json({ error: 'Invalid entry ID' });
  }
  
  const entry = await Entry.findById(entryId).select('-__v');
  
  if (!entry) {
    return res.status(404).json({ error: 'Entry not found' });
  }
  
  res.json(entry);
}));

app.delete('/api/entries/:id', handleAsync(async (req, res) => {
  await connectDB();
  
  const entryId = req.params.id;
  const { userId } = req.body;
  
  if (!mongoose.Types.ObjectId.isValid(entryId)) {
    return res.status(400).json({ error: 'Invalid entry ID' });
  }
  
  if (!userId) {
    return res.status(400).json({ error: 'User ID required' });
  }
  
  const entry = await Entry.findById(entryId);
  
  if (!entry) {
    return res.status(404).json({ error: 'Entry not found' });
  }
  
  if (entry.userId !== userId) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  await Entry.findByIdAndDelete(entryId);
  
  res.json({ message: 'Entry deleted successfully' });
}));

// File serving endpoint for uploaded files
app.get('/api/files/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  const fileBuffer = fileStorage.get(fileId);
  
  if (!fileBuffer) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  // Set appropriate headers
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${fileId}"`
  });
  
  res.send(fileBuffer);
});

// Test routes
app.get('/api/create-test-entry/:userId', handleAsync(async (req, res) => {
  await connectDB();
  
  const userId = req.params.userId;
  const testContent = Array(150).fill('This is test content for the business strategy entry.').join(' ');
  
  const entry = new Entry({
    userId,
    category: 'business',
    entryType: 'text',
    title: 'Test Business Entry',
    description: 'Test description',
    textContent: testContent,
    entryFee: 49,
    stripeFee: 2,
    totalAmount: 51,
    paymentIntentId: 'pi_test_' + Date.now(),
    paymentStatus: 'succeeded'
  });
  
  const saved = await entry.save();
  
  res.json({ 
    message: 'Test entry created', 
    id: saved._id,
    title: saved.title 
  });
}));

// Webhook handler
app.post('/api/webhook', handleAsync(async (req, res) => {
  if (!stripe) {
    return res.status(200).json({ received: true, message: 'Stripe not available' });
  }

  const sig = req.headers['stripe-signature'];
  let event;
  
  try {
    if (!STRIPE_WEBHOOK_SECRET) {
      console.warn('Webhook secret not configured');
      return res.status(200).json({ received: true });
    }
    
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  if (event.type === 'payment_intent.payment_failed') {
    await connectDB();
    const paymentIntent = event.data.object;
    
    await Entry.findOneAndUpdate(
      { paymentIntentId: paymentIntent.id },
      { paymentStatus: 'failed' }
    );
  }
  
  res.json({ received: true });
}));

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Error:', error);
  
  res.status(500).json({
    error: 'Internal server error',
    message: error.message
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.originalUrl
  });
});

// Export for Vercel
module.exports = app;
