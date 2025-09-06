const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');

// Initialize Express app
const app = express();

// Environment variables - Vercel automatically loads these
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const MONGODB_URI = process.env.MONGODB_URI;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Initialize Stripe with better error handling
let stripe;
try {
  if (STRIPE_SECRET_KEY) {
    stripe = require('stripe')(STRIPE_SECRET_KEY);
    console.log('✅ Stripe initialized');
  } else {
    console.warn('⚠️ STRIPE_SECRET_KEY not found - Stripe features disabled');
  }
} catch (error) {
  console.error('Failed to initialize Stripe:', error.message);
}

// Middleware - Order is important!
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://your-domain.vercel.app'] // Update with your actual domain
    : ['http://localhost:3000', 'http://localhost:5000'],
  credentials: true
}));

// Webhook route FIRST (needs raw body) - BEFORE other body parsing middleware
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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
  
  try {
    if (event.type === 'payment_intent.payment_failed') {
      await connectDB();
      const paymentIntent = event.data.object;
      
      await Entry.findOneAndUpdate(
        { paymentIntentId: paymentIntent.id },
        { paymentStatus: 'failed' }
      );
    }
    
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// JSON parsing for other routes (AFTER webhook)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// MongoDB connection - optimized for serverless with better error handling
let cachedConnection = null;

const connectDB = async () => {
  // Check if we have a cached connection and it's still active
  if (cachedConnection && mongoose.connection.readyState === 1) {
    console.log('Using cached database connection');
    return cachedConnection;
  }

  try {
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI not found in environment variables');
    }

    // Disconnect any existing connections
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }

    const opts = {
      bufferCommands: false,
      bufferMaxEntries: 0,
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxPoolSize: 1,
      minPoolSize: 0,
      maxIdleTimeMS: 30000,
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

// Create model safely
const Entry = mongoose.models.Entry || mongoose.model('Entry', entrySchema);

// In-memory storage for files (temporary - consider cloud storage for production)
const fileStorage = new Map();

// Multer configuration for file uploads
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
      environment: process.env.VERCEL_ENV || 'development',
      nodeVersion: process.version
    });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({
      status: 'ERROR',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
}));

app.post('/api/create-payment-intent', handleAsync(async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe not initialized' });
  }

  try {
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
  } catch (error) {
    console.error('Payment intent creation error:', error);
    res.status(500).json({ 
      error: 'Failed to create payment intent',
      message: error.message 
    });
  }
}));

app.post('/api/entries', (req, res) => {
  const uploadSingle = upload.single('file');
  
  uploadSingle(req, res, async (uploadErr) => {
    if (uploadErr) {
      console.error('Upload error:', uploadErr);
      return res.status(400).json({ error: uploadErr.message });
    }

    try {
      await connectDB();

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
      
    } catch (error) {
      console.error('Error creating entry:', error);
      res.status(500).json({ 
        error: 'Failed to submit entry',
        message: error.message
      });
    }
  });
});

app.get('/api/entries/:userId', handleAsync(async (req, res) => {
  try {
    await connectDB();
    
    const userId = req.params.userId;
    
    if (!userId || userId.length < 3) {
      return res.status(400).json({ error: 'Valid userId required' });
    }
    
    const entries = await Entry.find({ userId })
      .sort({ createdAt: -1 })
      .select('-__v');
    
    res.json(entries);
  } catch (error) {
    console.error('Error fetching entries:', error);
    res.status(500).json({ 
      error: 'Failed to fetch entries',
      message: error.message 
    });
  }
}));

app.get('/api/entry/:id', handleAsync(async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Error fetching entry:', error);
    res.status(500).json({ 
      error: 'Failed to fetch entry',
      message: error.message 
    });
  }
}));

app.delete('/api/entries/:id', handleAsync(async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Error deleting entry:', error);
    res.status(500).json({ 
      error: 'Failed to delete entry',
      message: error.message 
    });
  }
}));

// File serving endpoint
app.get('/api/files/:fileId', (req, res) => {
  try {
    const fileId = req.params.fileId;
    const fileBuffer = fileStorage.get(fileId);
    
    if (!fileBuffer) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fileId}"`
    });
    
    res.send(fileBuffer);
  } catch (error) {
    console.error('Error serving file:', error);
    res.status(500).json({ error: 'Failed to serve file' });
  }
});

// Test route
app.get('/api/create-test-entry/:userId', handleAsync(async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Error creating test entry:', error);
    res.status(500).json({ 
      error: 'Failed to create test entry',
      message: error.message 
    });
  }
}));

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.originalUrl,
    method: req.method
  });
});

// Export for Vercel
module.exports = app;
