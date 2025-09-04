const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
require('dotenv').config();

// Initialize Stripe with error checking
let stripe;
try {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('ERROR: STRIPE_SECRET_KEY not found in environment variables');
    if (process.env.NODE_ENV !== 'production') {
      process.exit(1);
    }
  } else {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('✅ Stripe initialized successfully');
  }
} catch (error) {
  console.error('ERROR: Failed to initialize Stripe:', error.message);
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
}

const app = express();

// CRITICAL: For Vercel, you need to configure body size limits properly
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? [process.env.FRONTEND_URL, `https://${process.env.VERCEL_URL}`]
    : 'http://localhost:3000',
  credentials: true
}));

// Increase payload limits for file uploads
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ limit: '30mb', extended: true }));

// FIXED: Use memory storage for Vercel compatibility
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  console.log('File received:', {
    fieldname: file.fieldname,
    originalname: file.originalname,
    mimetype: file.mimetype,
    size: file.size
  });
  
  const allowedTypes = {
    'application/pdf': '.pdf',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx'
  };
  
  if (allowedTypes[file.mimetype]) {
    cb(null, true);
  } else {
    console.error('Invalid file type:', file.mimetype);
    cb(new Error(`Invalid file type: ${file.mimetype}. Only PDF, PPT, and PPTX files are allowed.`), false);
  }
};

// FIXED: Proper multer configuration for Vercel
const upload = multer({
  storage: storage,
  limits: { 
    fileSize: 25 * 1024 * 1024, // 25MB limit
    fieldSize: 25 * 1024 * 1024  // Field size limit
  },
  fileFilter: fileFilter
});

// MongoDB Connection with retry logic for serverless
const connectDB = async () => {
  try {
    if (mongoose.connection.readyState === 1) {
      console.log('✅ MongoDB already connected');
      return;
    }
    
    const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/top216';
    
    await mongoose.connect(mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      bufferCommands: false,
      bufferMaxEntries: 0
    });
    
    console.log('✅ MongoDB connected successfully');
    console.log('📍 Database:', mongoose.connection.name);
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    throw error;
  }
};

// Entry Schema - Optimized for file storage
const entrySchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
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
  // FIXED: More efficient file storage
  fileData: {
    type: Buffer, // Use Buffer instead of String for better performance
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
  fileName: { type: String },
  fileType: { type: String },
  fileSize: { type: Number },
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
  paymentIntentId: { type: String, required: true, index: true },
  paymentStatus: { type: String, enum: ['pending', 'succeeded', 'failed'], default: 'pending' },
  submissionDate: { type: Date, default: Date.now },
  status: { type: String, enum: ['submitted', 'under-review', 'finalist', 'winner', 'rejected'], default: 'submitted' }
}, { 
  timestamps: true,
  // FIXED: Add indexes for better performance
  indexes: [
    { userId: 1, createdAt: -1 },
    { paymentIntentId: 1 }
  ]
});

const Entry = mongoose.model('Entry', entrySchema);

// Helper function to calculate fees
const calculateFees = (baseAmount) => {
  const stripeFee = Math.ceil(baseAmount * 0.04); // 4% fee, rounded up
  const totalAmount = baseAmount + stripeFee;
  return { stripeFee, totalAmount };
};

// ROOT ROUTE
app.get('/', (req, res) => {
  res.json({
    message: '🏆 Top 216 Competition API',
    status: 'deployed and running',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    endpoints: {
      health: '/api/health',
      status: '/api/status', 
      createPaymentIntent: 'POST /api/create-payment-intent',
      submitEntry: 'POST /api/entries',
      getUserEntries: 'GET /api/entries/:userId',
      downloadFile: 'GET /api/entries/:entryId/download'
    }
  });
});

// FIXED: Middleware for DB connection in serverless
const ensureDBConnection = async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      await connectDB();
    }
    next();
  } catch (error) {
    console.error('Database connection error:', error);
    res.status(500).json({ error: 'Database connection failed' });
  }
};

app.get('/api/health', ensureDBConnection, (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    version: '1.0.0',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    stripe: stripe ? 'initialized' : 'not initialized'
  });
});

app.get('/api/status', ensureDBConnection, (req, res) => {
  const status = {
    server: 'running',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    stripe: stripe ? 'configured' : 'not configured',
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
    memoryUsage: process.memoryUsage(),
    version: process.version,
    // FIXED: More detailed environment check
    deployment: {
      url: process.env.VERCEL_URL,
      region: process.env.VERCEL_REGION,
      git_commit: process.env.VERCEL_GIT_COMMIT_SHA
    }
  };
  res.json(status);
});

app.post('/api/create-payment-intent', ensureDBConnection, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }
    
    console.log('Payment intent request:', req.body);
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
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmount * 100, // Convert to cents
      currency: 'usd',
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
    console.error('Error creating payment intent:', error);
    res.status(500).json({ 
      error: 'Failed to create payment intent',
      message: error.message
    });
  }
});

// FIXED: Better error handling for file uploads in Vercel
app.post('/api/entries', ensureDBConnection, (req, res) => {
  // Use multer middleware with proper error handling
  upload.single('file')(req, res, async (err) => {
    if (err) {
      console.error('Multer error:', err);
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File size exceeds 25MB limit' });
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ error: 'Unexpected file field' });
        }
      }
      return res.status(400).json({ error: err.message });
    }

    try {
      console.log('Entry submission received:', {
        body: req.body,
        file: req.file ? { 
          filename: req.file.originalname, 
          size: req.file.size,
          mimetype: req.file.mimetype 
        } : null
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

      // FIXED: Better file validation for pitch-deck
      if (entryType === 'pitch-deck') {
        if (!req.file) {
          return res.status(400).json({ error: 'File required for pitch-deck entries' });
        }
        
        console.log('Validating file:', {
          size: req.file.size,
          mimetype: req.file.mimetype,
          originalname: req.file.originalname
        });

        const allowedTypes = [
          'application/pdf',
          'application/vnd.ms-powerpoint',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        ];
        
        if (!allowedTypes.includes(req.file.mimetype)) {
          return res.status(400).json({ 
            error: `Invalid file type: ${req.file.mimetype}. Only PDF, PPT, PPTX allowed.` 
          });
        }
        
        if (req.file.size > 25 * 1024 * 1024) {
          return res.status(400).json({ 
            error: `File size (${Math.round(req.file.size / (1024 * 1024))}MB) exceeds 25MB limit.` 
          });
        }
      }

      if (!stripe) {
        return res.status(500).json({ error: 'Stripe not configured' });
      }

      // Verify payment
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

      // Handle different entry types
      if (entryType === 'text') {
        entryData.textContent = textContent;
      } else if (entryType === 'pitch-deck' && req.file) {
        // FIXED: Store file as Buffer (more efficient than base64)
        entryData.fileData = req.file.buffer;
        entryData.fileName = req.file.originalname;
        entryData.fileType = req.file.mimetype;
        entryData.fileSize = req.file.size;
        
        console.log('Storing file:', {
          fileName: entryData.fileName,
          fileType: entryData.fileType,
          fileSize: entryData.fileSize,
          bufferLength: req.file.buffer.length
        });
      } else if (entryType === 'video') {
        entryData.videoUrl = videoUrl;
      }

      console.log('Creating entry with data:', { 
        ...entryData, 
        fileData: entryData.fileData ? `[BUFFER_${entryData.fileData.length}_BYTES]` : undefined 
      });

      const entry = new Entry(entryData);
      await entry.save();
      
      console.log('Entry created successfully:', entry._id);
      res.status(201).json({ 
        message: 'Entry submitted successfully', 
        entryId: entry._id,
        fileSize: entryData.fileSize || 0
      });
      
    } catch (error) {
      console.error('Error submitting entry:', error);
      res.status(500).json({ 
        error: 'Failed to submit entry',
        message: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });
});

// FIXED: File download endpoint with proper error handling
app.get('/api/entries/:entryId/download', ensureDBConnection, async (req, res) => {
  try {
    const entry = await Entry.findById(req.params.entryId);
    
    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }
    
    if (!entry.fileData || entry.entryType !== 'pitch-deck') {
      return res.status(404).json({ error: 'File not found for this entry' });
    }
    
    console.log('Serving file:', {
      fileName: entry.fileName,
      fileType: entry.fileType,
      fileSize: entry.fileSize,
      bufferLength: entry.fileData.length
    });
    
    // FIXED: Proper headers and buffer handling
    res.set({
      'Content-Type': entry.fileType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${entry.fileName || 'download'}"`,
      'Content-Length': entry.fileData.length,
      'Cache-Control': 'private, no-cache'
    });
    
    res.send(entry.fileData);
    
  } catch (error) {
    console.error('Error downloading file:', error);
    res.status(500).json({ 
      error: 'Failed to download file',
      message: error.message
    });
  }
});

// FIXED: Get entries with proper field selection
app.get('/api/entries/:userId', ensureDBConnection, async (req, res) => {
  try {
    console.log('Fetching entries for user:', req.params.userId);
    
    const entries = await Entry.find({ userId: req.params.userId })
      .select('-fileData') // Exclude file data from list view for performance
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

app.get('/api/entry/:id', ensureDBConnection, async (req, res) => {
  try {
    const entry = await Entry.findById(req.params.id).select('-fileData');
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

app.delete('/api/entries/:id', ensureDBConnection, async (req, res) => {
  try {
    const entryId = req.params.id;
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId required for deletion' });
    }
    
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
      message: error.message
    });
  }
});

// FIXED: Test entry creation
app.get('/api/create-test-entry/:userId', ensureDBConnection, async (req, res) => {
  try {
    const userId = req.params.userId;
    const entry = new Entry({
      userId,
      category: 'business',
      entryType: 'text',
      title: 'Sample Business Strategy Entry',
      description: 'A comprehensive business strategy for digital transformation in modern enterprises',
      textContent: 'This is a detailed business strategy focusing on digital transformation in modern enterprises. The strategy emphasizes leveraging cloud computing, artificial intelligence, and data analytics to drive operational efficiency and customer engagement. We propose implementing a phased approach that begins with infrastructure modernization, followed by process automation, and culminating in AI-driven decision making systems. This transformation will enable organizations to remain competitive in an increasingly digital marketplace while ensuring scalability and security. The implementation timeline spans 18 months with clear milestones and ROI metrics. Key performance indicators include reduced operational costs, improved customer satisfaction scores, and increased market responsiveness. This comprehensive approach ensures sustainable growth and long-term competitive advantage in the digital economy.',
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

// FIXED: Webhook with proper middleware ordering
app.post('/api/webhook', express.raw({ type: 'application/json' }), ensureDBConnection, async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }
  
  const sig = req.headers['stripe-signature'];
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log('Webhook event received:', event.type);
  } catch (err) {
    console.log(`Webhook signature verification failed:`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object;
      await Entry.findOneAndUpdate(
        { paymentIntentId: paymentIntent.id },
        { paymentStatus: 'failed' }
      );
      console.log('Payment failed, updated entry status');
    }
    
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// FIXED: Better error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  
  // Handle specific error types
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      error: 'File too large',
      message: 'File size exceeds the 25MB limit'
    });
  }
  
  if (error.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      error: 'Unexpected file',
      message: 'File upload field name is incorrect'
    });
  }
  
  res.status(500).json({
    error: 'Internal server error',
    message: error.message,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
  });
});

// Handle 404s
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
    method: req.method
  });
});

const PORT = process.env.PORT || 5000;

// For local development
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log('🚀 Server running on port', PORT);
    console.log('📊 Health check: http://localhost:' + PORT + '/api/health');
    connectDB();
  });
} else {
  console.log('🌐 Vercel serverless function initialized');
}

// Export for Vercel
module.exports = app;
