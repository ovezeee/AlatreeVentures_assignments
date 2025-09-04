const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();

// Basic CORS configuration - more permissive for debugging
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature']
}));

// Handle preflight
app.options('*', cors());

// Basic middleware
app.use(express.json());

// Global variables for services
let stripe = null;
let mongoose = null;
let Entry = null;

// Initialize services with graceful error handling
const initializeServices = async () => {
  try {
    // Initialize Stripe
    if (process.env.STRIPE_SECRET_KEY) {
      stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      console.log('✅ Stripe initialized');
    } else {
      console.warn('⚠️ STRIPE_SECRET_KEY not found - payment features disabled');
    }

    // Initialize MongoDB
    if (process.env.MONGODB_URI) {
      mongoose = require('mongoose');
      await mongoose.connect(process.env.MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
      console.log('✅ MongoDB connected');

      // Define Entry schema only after MongoDB connects
      const entrySchema = new mongoose.Schema({
        userId: { type: String, required: true },
        category: { type: String, required: true, enum: ['business', 'creative', 'technology', 'social-impact'] },
        entryType: { type: String, required: true, enum: ['text', 'pitch-deck', 'video'] },
        title: { type: String, required: true, minlength: 5, maxlength: 100 },
        description: { type: String, maxlength: 1000 },
        textContent: String,
        fileUrl: String,
        videoUrl: String,
        entryFee: { type: Number, required: true },
        stripeFee: { type: Number, required: true },
        totalAmount: { type: Number, required: true },
        paymentIntentId: { type: String, required: true },
        paymentStatus: { type: String, enum: ['pending', 'succeeded', 'failed'], default: 'pending' },
        submissionDate: { type: Date, default: Date.now },
        status: { type: String, enum: ['submitted', 'under-review', 'finalist', 'winner', 'rejected'], default: 'submitted' }
      }, { timestamps: true });

      Entry = mongoose.model('Entry', entrySchema);
    } else {
      console.warn('⚠️ MONGODB_URI not found - database features disabled');
    }

  } catch (error) {
    console.error('Service initialization error:', error.message);
    // Don't throw - let the server start anyway for health checks
  }
};

// Create uploads directory
const createUploadsDir = () => {
  try {
    const uploadsDir = '/tmp/uploads';
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
      console.log('✅ Created uploads directory');
    }
  } catch (error) {
    console.warn('⚠️ Could not create uploads directory:', error.message);
  }
};

// Initialize on startup
createUploadsDir();
initializeServices().catch(err => console.error('Startup error:', err.message));

// Health check route
app.get('/api/health', (req, res) => {
  const status = {
    server: 'OK',
    timestamp: new Date().toISOString(),
    stripe: stripe ? 'Connected' : 'Not configured',
    mongodb: mongoose && mongoose.connection.readyState === 1 ? 'Connected' : 'Not connected',
    uploads: fs.existsSync('/tmp/uploads') ? 'Ready' : 'Not available'
  };
  
  res.json(status);
});

// Root route
app.get('/', (req, res) => {
  res.json({ 
    message: 'Top216 Server Running',
    status: 'OK',
    health: '/api/health'
  });
});

// Helper function to check if services are ready
const checkServices = (requiredServices = []) => {
  const errors = [];
  if (requiredServices.includes('stripe') && !stripe) {
    errors.push('Stripe not configured');
  }
  if (requiredServices.includes('mongodb') && (!mongoose || mongoose.connection.readyState !== 1)) {
    errors.push('MongoDB not connected');
  }
  return errors;
};

// Payment intent creation
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const serviceErrors = checkServices(['stripe']);
    if (serviceErrors.length > 0) {
      return res.status(503).json({ 
        error: 'Payment service unavailable', 
        details: serviceErrors 
      });
    }

    const { category, entryType } = req.body;
    if (!category || !entryType) {
      return res.status(400).json({ 
        error: 'Category and entryType are required' 
      });
    }

    const baseFees = { 'business': 49, 'creative': 49, 'technology': 99, 'social-impact': 49 };
    const entryFee = baseFees[category];
    
    if (!entryFee) {
      return res.status(400).json({ 
        error: 'Invalid category',
        validCategories: Object.keys(baseFees)
      });
    }

    const stripeFee = Math.ceil(entryFee * 0.04);
    const totalAmount = entryFee + stripeFee;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmount * 100,
      currency: 'usd',
      metadata: { category, entryType, entryFee: entryFee.toString(), stripeFee: stripeFee.toString() }
    });

    res.json({ 
      clientSecret: paymentIntent.client_secret, 
      entryFee, 
      stripeFee, 
      totalAmount 
    });

  } catch (error) {
    console.error('Payment intent error:', error.message);
    res.status(500).json({ 
      error: 'Failed to create payment intent',
      message: error.message
    });
  }
});

// Get user entries
app.get('/api/entries/:userId', async (req, res) => {
  try {
    const serviceErrors = checkServices(['mongodb']);
    if (serviceErrors.length > 0) {
      return res.status(503).json({ 
        error: 'Database service unavailable', 
        details: serviceErrors 
      });
    }

    const entries = await Entry.find({ userId: req.params.userId }).sort({ createdAt: -1 });
    res.json(entries);

  } catch (error) {
    console.error('Error fetching entries:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch entries',
      message: error.message
    });
  }
});

// Create test entry for debugging
app.get('/api/create-test-entry/:userId', async (req, res) => {
  try {
    const serviceErrors = checkServices(['mongodb']);
    if (serviceErrors.length > 0) {
      return res.status(503).json({ 
        error: 'Database service unavailable', 
        details: serviceErrors 
      });
    }

    const userId = req.params.userId;
    const entry = new Entry({
      userId,
      category: 'business',
      entryType: 'text',
      title: 'Sample Business Strategy Entry',
      description: 'A comprehensive business strategy for digital transformation',
      textContent: 'This is a detailed business strategy for modern digital transformation initiatives. '.repeat(15), // ~150 words
      entryFee: 49,
      stripeFee: 2,
      totalAmount: 51,
      paymentIntentId: 'pi_test_' + Date.now(),
      paymentStatus: 'succeeded'
    });
    
    await entry.save();
    
    res.json({ 
      message: 'Test entry created successfully', 
      id: entry._id,
      title: entry.title 
    });

  } catch (error) {
    console.error('Error creating test entry:', error.message);
    res.status(500).json({ 
      error: 'Failed to create test entry',
      message: error.message
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Global error handler:', error.message);
  res.status(500).json({
    error: 'Internal server error',
    message: error.message,
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
    method: req.method
  });
});

const PORT = process.env.PORT || 5000;

// Don't crash the server if listen fails
try {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
} catch (error) {
  console.error('Failed to start server:', error.message);
}

// Export for Vercel
module.exports = app;
