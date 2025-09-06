const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

// Initialize Express app
const app = express();

// Environment variables
const MONGODB_URI = process.env.MONGODB_URI;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

console.log('Starting server...');
console.log('Environment:', process.env.NODE_ENV);
console.log('MongoDB URI exists:', !!MONGODB_URI);
console.log('Stripe Key exists:', !!STRIPE_SECRET_KEY);

// Initialize Stripe with error handling
let stripe = null;
try {
  if (STRIPE_SECRET_KEY) {
    stripe = require('stripe')(STRIPE_SECRET_KEY);
    console.log('✅ Stripe initialized successfully');
  } else {
    console.log('⚠️ Stripe key not found - payment features disabled');
  }
} catch (error) {
  console.error('❌ Stripe initialization failed:', error.message);
}

// Basic middleware
app.use(cors({
  origin: true, // Allow all origins for testing
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// MongoDB connection with better error handling
let isConnected = false;

const connectDB = async () => {
  if (isConnected && mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  try {
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI environment variable is required');
    }

    console.log('Connecting to MongoDB...');
    
    const connection = await mongoose.connect(MONGODB_URI, {
      bufferCommands: false,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxPoolSize: 1
    });

    isConnected = true;
    console.log('✅ MongoDB connected successfully');
    return connection;

  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    isConnected = false;
    throw error;
  }
};

// Simple Entry Schema
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
  textContent: { type: String },
  fileUrl: { type: String },
  videoUrl: { type: String },
  entryFee: { type: Number, required: true, min: 0 },
  stripeFee: { type: Number, required: true, min: 0 },
  totalAmount: { type: Number, required: true, min: 0 },
  paymentIntentId: { type: String, required: true },
  paymentStatus: { 
    type: String, 
    enum: ['pending', 'succeeded', 'failed'], 
    default: 'pending' 
  },
  status: { 
    type: String, 
    enum: ['submitted', 'under-review', 'finalist', 'winner', 'rejected'], 
    default: 'submitted' 
  }
}, { timestamps: true });

// Create model safely
const Entry = mongoose.models.Entry || mongoose.model('Entry', entrySchema);

// Helper function for async routes
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch((error) => {
    console.error('Route error:', error);
    next(error);
  });
};

// Fee calculation
const calculateFees = (baseAmount) => {
  const stripeFee = Math.ceil(baseAmount * 0.04);
  const totalAmount = baseAmount + stripeFee;
  return { stripeFee, totalAmount };
};

// Routes
app.get('/api/health', asyncHandler(async (req, res) => {
  console.log('Health check requested');
  
  let dbStatus = 'disconnected';
  let dbError = null;
  
  try {
    await connectDB();
    dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  } catch (error) {
    dbError = error.message;
  }
  
  const healthInfo = {
    status: 'OK',
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
    database: {
      status: dbStatus,
      error: dbError
    },
    services: {
      stripe: !!stripe,
      mongodb: !!MONGODB_URI
    }
  };
  
  console.log('Health check response:', healthInfo);
  res.json(healthInfo);
}));

app.get('/api/test', (req, res) => {
  console.log('Test endpoint hit');
  res.json({
    message: 'Test endpoint working',
    timestamp: new Date().toISOString(),
    headers: req.headers
  });
});

app.post('/api/create-payment-intent', asyncHandler(async (req, res) => {
  console.log('Payment intent creation requested:', req.body);

  if (!stripe) {
    return res.status(500).json({ 
      error: 'Stripe not available',
      message: 'Payment processing is currently unavailable' 
    });
  }

  const { category, entryType } = req.body;
  
  if (!category || !entryType) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['category', 'entryType'],
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
      validCategories: Object.keys(baseFees),
      received: category
    });
  }
  
  const { stripeFee, totalAmount } = calculateFees(entryFee);
  
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmount * 100, // Convert to cents
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: { 
        category, 
        entryType, 
        entryFee: entryFee.toString(), 
        stripeFee: stripeFee.toString() 
      }
    });
    
    console.log('Payment intent created:', paymentIntent.id);
    
    res.json({ 
      clientSecret: paymentIntent.client_secret, 
      entryFee, 
      stripeFee, 
      totalAmount 
    });
    
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({
      error: 'Payment intent creation failed',
      message: error.message
    });
  }
}));

app.get('/api/entries/:userId', asyncHandler(async (req, res) => {
  console.log('Fetching entries for user:', req.params.userId);
  
  await connectDB();
  
  const userId = req.params.userId;
  
  if (!userId || userId.length < 3) {
    return res.status(400).json({ 
      error: 'Valid userId required',
      received: userId
    });
  }
  
  const entries = await Entry.find({ userId })
    .sort({ createdAt: -1 })
    .select('-__v')
    .limit(50); // Limit results
  
  console.log(`Found ${entries.length} entries for user ${userId}`);
  res.json(entries);
}));

app.post('/api/entries', asyncHandler(async (req, res) => {
  console.log('Creating entry:', req.body);
  
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
  
  // Basic validation
  if (!userId || !category || !entryType || !title || !paymentIntentId) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['userId', 'category', 'entryType', 'title', 'paymentIntentId'],
      received: { userId, category, entryType, title, paymentIntentId }
    });
  }

  // For testing, we'll create a mock entry without Stripe verification
  const baseFees = { 
    'business': 49, 
    'creative': 49, 
    'technology': 99, 
    'social-impact': 49 
  };
  
  const entryFee = baseFees[category] || 49;
  const { stripeFee, totalAmount } = calculateFees(entryFee);
  
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
    paymentStatus: 'succeeded' // For testing
  };
  
  // Add type-specific data
  if (entryType === 'text' && textContent) {
    entryData.textContent = textContent;
  } else if (entryType === 'video' && videoUrl) {
    entryData.videoUrl = videoUrl;
  }
  
  const entry = new Entry(entryData);
  const savedEntry = await entry.save();
  
  console.log('Entry created:', savedEntry._id);
  
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
}));

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', {
    message: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method
  });
  
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use('*', (req, res) => {
  console.log('404 - Route not found:', req.method, req.originalUrl);
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
    method: req.method
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing server...');
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.close();
  }
  process.exit(0);
});

console.log('Server configuration complete');

module.exports = app;
