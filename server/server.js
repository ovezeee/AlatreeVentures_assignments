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

// Create uploads directory if it doesn't exist
const uploadsDir = 'uploads';
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('✅ Created uploads directory');
}

// Middleware - IMPORTANT: Order matters!
app.use(cors());

// Raw body parser for webhooks MUST come before express.json()
app.use('/api/webhook', express.raw({ type: 'application/json' }));

// JSON parser for other routes
app.use(express.json());

// Static file serving
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// MongoDB Connection with error handling
const connectDB = async () => {
  try {
    const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/top216';
    console.log('Attempting to connect to MongoDB...');
    
    await mongoose.connect(mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 10000, // 10 second timeout
      socketTimeoutMS: 45000, // 45 second socket timeout
    });
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    console.error('ERROR: MongoDB connection failed:', error.message);
    console.log('Connection string (partial):', process.env.MONGODB_URI ? process.env.MONGODB_URI.substring(0, 20) + '...' : 'Not provided');
    // Don't exit in production, allow server to start without DB
    if (process.env.NODE_ENV !== 'production') {
      process.exit(1);
    }
  }
};

// Handle MongoDB connection events
mongoose.connection.on('error', err => {
  console.error('MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('MongoDB disconnected');
});

connectDB();

// Entry Schema with better validation
const entrySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  category: { 
    type: String, 
    required: true, 
    enum: {
      values: ['business', 'creative', 'technology', 'social-impact'],
      message: 'Invalid category: {VALUE}'
    }
  },
  entryType: { 
    type: String, 
    required: true, 
    enum: {
      values: ['text', 'pitch-deck', 'video'],
      message: 'Invalid entry type: {VALUE}'
    }
  },
  title: { 
    type: String, 
    required: true, 
    minlength: [5, 'Title must be at least 5 characters'],
    maxlength: [100, 'Title cannot exceed 100 characters']
  },
  description: { 
    type: String, 
    maxlength: [1000, 'Description cannot exceed 1000 characters']
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
  fileUrl: {
    type: String,
    validate: {
      validator: function (v) {
        if (this.entryType === 'pitch-deck') {
          return !!v;
        }
        return true;
      },
      message: 'File URL required for pitch deck entries'
    }
  },
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
}, { 
  timestamps: true,
  // Add error handling for validation
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Add indexes for better performance
entrySchema.index({ userId: 1, createdAt: -1 });
entrySchema.index({ paymentIntentId: 1 });

const Entry = mongoose.model('Entry', entrySchema);

// File upload configuration with better error handling
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    // Sanitize filename
    const originalName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(originalName);
    const name = path.basename(originalName, ext);
    cb(null, `${name}-${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = {
    'application/pdf': '.pdf',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx'
  };
  
  if (allowedTypes[file.mimetype]) {
    cb(null, true);
  } else {
    console.log('Rejected file type:', file.mimetype, 'for file:', file.originalname);
    cb(new Error(`Invalid file type: ${file.mimetype}. Only PDF and PowerPoint files are allowed.`), false);
  }
};

const upload = multer({
  storage: storage,
  limits: { 
    fileSize: 25 * 1024 * 1024, // 25MB limit
    files: 1 // Only allow 1 file
  },
  fileFilter: fileFilter
}).single('file');

// Helper function to calculate fees
const calculateFees = (baseAmount) => {
  const stripeFee = Math.ceil(baseAmount * 0.04); // 4% fee, rounded up
  const totalAmount = baseAmount + stripeFee;
  return { stripeFee, totalAmount };
};

// Error handling middleware for multer
const handleUpload = (req, res, next) => {
  upload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      console.error('Multer error:', err);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File size exceeds 25MB limit' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    } else if (err) {
      console.error('Upload error:', err);
      return res.status(400).json({ error: err.message });
    }
    next();
  });
};

// Routes with better error handling
app.get('/api/health', (req, res) => {
  try {
    const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    res.json({ 
      status: 'OK', 
      message: 'Server is running',
      timestamp: new Date().toISOString(),
      database: dbStatus,
      node_env: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({ error: 'Health check failed' });
  }
});

// Test routes with validation
app.get('/api/create-test-entry/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    
    if (!userId || userId.length < 3) {
      return res.status(400).json({ error: 'Valid userId required' });
    }

    const testContent = Array(50).fill('This is a detailed business strategy focusing on digital transformation and market expansion.').join(' ');
    
    const entry = new Entry({
      userId,
      category: 'business',
      entryType: 'text',
      title: 'Sample Business Strategy Entry',
      description: 'A comprehensive business strategy for digital transformation in modern enterprises',
      textContent: testContent,
      entryFee: 49,
      stripeFee: 2,
      totalAmount: 51,
      paymentIntentId: 'pi_test_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      paymentStatus: 'succeeded'
    });
    
    const savedEntry = await entry.save();
    console.log('Test entry created:', savedEntry._id);
    
    res.json({ 
      message: 'Test entry created successfully', 
      id: savedEntry._id,
      title: savedEntry.title 
    });
  } catch (error) {
    console.error('Error creating test entry:', error);
    res.status(500).json({ 
      error: 'Failed to create test entry',
      message: error.message 
    });
  }
});

app.get('/api/create-test-entries/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    
    if (!userId || userId.length < 3) {
      return res.status(400).json({ error: 'Valid userId required' });
    }

    const longText = Array(50).fill('This business strategy focuses on digital transformation and innovative market approaches.').join(' ');
    
    const testEntries = [
      {
        userId,
        category: 'business',
        entryType: 'text',
        title: 'Innovative Business Strategy',
        description: 'A comprehensive business strategy for modern markets',
        textContent: longText,
        entryFee: 49,
        stripeFee: 2,
        totalAmount: 51,
        paymentIntentId: 'pi_test_business_' + Date.now(),
        paymentStatus: 'succeeded',
        status: 'submitted'
      },
      {
        userId,
        category: 'technology',
        entryType: 'pitch-deck',
        title: 'AI-Powered Solution Platform',
        description: 'Revolutionary AI application for enterprise automation',
        fileUrl: '/uploads/sample-ai-deck.pdf',
        entryFee: 99,
        stripeFee: 4,
        totalAmount: 103,
        paymentIntentId: 'pi_test_tech_' + Date.now(),
        paymentStatus: 'succeeded',
        status: 'under-review'
      },
      {
        userId,
        category: 'creative',
        entryType: 'video',
        title: 'Creative Digital Showcase',
        description: 'Artistic expression through innovative digital media',
        videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        entryFee: 49,
        stripeFee: 2,
        totalAmount: 51,
        paymentIntentId: 'pi_test_creative_' + Date.now(),
        paymentStatus: 'succeeded',
        status: 'finalist'
      }
    ];
    
    const savedEntries = await Entry.insertMany(testEntries);
    console.log(`Created ${savedEntries.length} test entries for user: ${userId}`);
    
    res.json({ 
      message: `Created ${savedEntries.length} test entries successfully`,
      entries: savedEntries.map(e => ({ 
        id: e._id, 
        title: e.title, 
        status: e.status,
        category: e.category,
        entryType: e.entryType
      }))
    });
  } catch (error) {
    console.error('Error creating test entries:', error);
    res.status(500).json({ 
      error: 'Failed to create test entries',
      message: error.message
    });
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
    
    console.log('Creating payment intent with amount:', totalAmount * 100, 'cents');
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmount * 100, // Stripe expects cents
      currency: 'usd',
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: { 
        category, 
        entryType, 
        entryFee: entryFee.toString(), 
        stripeFee: stripeFee.toString() 
      }
    });
    
    console.log('Payment intent created successfully:', paymentIntent.id);
    
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
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.post('/api/entries', handleUpload, async (req, res) => {
  try {
    console.log('Entry submission received:', {
      body: req.body,
      file: req.file ? { 
        filename: req.file.filename, 
        size: req.file.size,
        mimetype: req.file.mimetype 
      } : null
    });
    
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
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['userId', 'category', 'entryType', 'title', 'paymentIntentId'],
        received: { userId, category, entryType, title, paymentIntentId }
      });
    }

    // Validate category and entryType
    const validCategories = ['business', 'creative', 'technology', 'social-impact'];
    const validEntryTypes = ['text', 'pitch-deck', 'video'];
    
    if (!validCategories.includes(category)) {
      return res.status(400).json({ 
        error: 'Invalid category',
        validCategories,
        received: category
      });
    }
    
    if (!validEntryTypes.includes(entryType)) {
      return res.status(400).json({ 
        error: 'Invalid entry type',
        validEntryTypes,
        received: entryType
      });
    }

    // Entry type specific validation
    if (entryType === 'pitch-deck' && !req.file) {
      return res.status(400).json({ error: 'File required for pitch-deck entries' });
    }
    
    if (entryType === 'text' && (!textContent || textContent.trim().length === 0)) {
      return res.status(400).json({ error: 'Text content required for text entries' });
    }
    
    if (entryType === 'video' && (!videoUrl || videoUrl.trim().length === 0)) {
      return res.status(400).json({ error: 'Video URL required for video entries' });
    }

    // Verify payment intent
    console.log('Verifying payment intent:', paymentIntentId);
    let paymentIntent;
    
    try {
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    } catch (stripeError) {
      console.error('Stripe error:', stripeError);
      return res.status(400).json({ 
        error: 'Invalid payment intent ID',
        message: stripeError.message
      });
    }
    
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ 
        error: 'Payment not completed',
        paymentStatus: paymentIntent.status
      });
    }
    
    // Extract fee information from payment intent
    const entryFee = parseInt(paymentIntent.metadata.entryFee);
    const stripeFee = parseInt(paymentIntent.metadata.stripeFee);
    const totalAmount = entryFee + stripeFee;
    
    // Build entry data
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
    
    // Add type-specific data
    if (entryType === 'text') {
      entryData.textContent = textContent;
    } else if (entryType === 'pitch-deck' && req.file) {
      entryData.fileUrl = `/uploads/${req.file.filename}`;
    } else if (entryType === 'video') {
      entryData.videoUrl = videoUrl;
    }
    
    console.log('Creating entry with data:', entryData);
    
    const entry = new Entry(entryData);
    const savedEntry = await entry.save();
    
    console.log('Entry created successfully:', savedEntry._id);
    
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
    console.error('Error submitting entry:', error);
    
    // If it's a validation error, provide specific details
    if (error.name === 'ValidationError') {
      const validationErrors = Object.keys(error.errors).map(key => ({
        field: key,
        message: error.errors[key].message
      }));
      
      return res.status(400).json({ 
        error: 'Validation failed',
        validationErrors,
        message: error.message
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to submit entry',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.get('/api/entries/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    
    if (!userId || userId.length < 3) {
      return res.status(400).json({ error: 'Valid userId required' });
    }
    
    console.log('Fetching entries for user:', userId);
    
    const entries = await Entry.find({ userId })
      .sort({ createdAt: -1 })
      .select('-__v'); // Exclude version key
    
    console.log(`Found ${entries.length} entries for user:`, userId);
    
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
    const entryId = req.params.id;
    
    if (!mongoose.Types.ObjectId.isValid(entryId)) {
      return res.status(400).json({ error: 'Invalid entry ID format' });
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
});

app.delete('/api/entries/:id', async (req, res) => {
  try {
    const entryId = req.params.id;
    const { userId } = req.body;
    
    if (!mongoose.Types.ObjectId.isValid(entryId)) {
      return res.status(400).json({ error: 'Invalid entry ID format' });
    }
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }
    
    console.log('Deleting entry:', entryId, 'for user:', userId);
    
    const entry = await Entry.findById(entryId);
    
    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }
    
    if (entry.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized to delete this entry' });
    }
    
    // Delete associated file if it exists
    if (entry.entryType === 'pitch-deck' && entry.fileUrl) {
      const filePath = path.join(__dirname, entry.fileUrl);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log('Deleted file:', filePath);
        }
      } catch (fileError) {
        console.error('Error deleting file:', fileError.message);
        // Don't fail the request if file deletion fails
      }
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

// Webhook handler - MUST be before other middleware that parses body
app.post('/api/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  
  try {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.warn('STRIPE_WEBHOOK_SECRET not set, webhook verification skipped');
      return res.status(200).json({ received: true, message: 'Webhook secret not configured' });
    }
    
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`Webhook signature verification failed:`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  console.log('Webhook event received:', event.type);
  
  // Handle the event
  if (event.type === 'payment_intent.payment_failed') {
    const paymentIntent = event.data.object;
    console.log('Payment failed for:', paymentIntent.id);
    
    Entry.findOneAndUpdate(
      { paymentIntentId: paymentIntent.id },
      { paymentStatus: 'failed' }
    ).exec().catch(err => {
      console.error('Error updating payment status:', err);
    });
  }
  
  res.json({ received: true });
});

// Global error handler - MUST be last
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  
  // Don't send error details in production
  const isDev = process.env.NODE_ENV === 'development';
  
  res.status(500).json({
    error: 'Internal server error',
    message: isDev ? error.message : 'Something went wrong',
    stack: isDev ? error.stack : undefined
  });
});

// 404 handler for unmatched routes
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
    availableRoutes: [
      'GET /api/health',
      'GET /api/entries/:userId',
      'GET /api/entry/:id',
      'POST /api/create-payment-intent',
      'POST /api/entries',
      'DELETE /api/entries/:id',
      'POST /api/webhook'
    ]
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🧪 Create test entry: http://localhost:${PORT}/api/create-test-entry/user_test123`);
  console.log(`🧪 Create test entries: http://localhost:${PORT}/api/create-test-entries/user_test123`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});
