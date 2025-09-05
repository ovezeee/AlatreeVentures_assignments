const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

const app = express();

// Initialize Stripe with fallback
let stripe;
try {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY not found in environment variables');
  }
  if (!process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
    throw new Error('STRIPE_SECRET_KEY is not a test key');
  }
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  console.log('✅ Stripe initialized successfully in test mode');
} catch (error) {
  console.error('ERROR: Failed to initialize Stripe:', error.message);
  stripe = null;
}

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection with retry logic
const connectDB = async () => {
  if (mongoose.connection.readyState === 1) {
    console.log('✅ Using existing MongoDB connection');
    return;
  }
  try {
    const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/top216';
    await mongoose.connect(mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 10,
    });
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    console.error('ERROR: MongoDB connection failed:', error.message);
    throw new Error(`MongoDB connection failed: ${error.message}`);
  }
};

// Entry Schema - Updated to store files as base64 or use cloud storage
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
  // Store file as base64 or cloud storage URL for serverless compatibility
  fileData: {
    type: String, // Base64 encoded file content
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
  fileName: String, // Original filename
  fileMimeType: String, // File MIME type
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

// Configure multer for memory storage (serverless compatible)
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

// Helper function to calculate fees
const calculateFees = (baseAmount) => {
  const stripeFee = Math.ceil(baseAmount * 0.04);
  const totalAmount = baseAmount + stripeFee;
  return { stripeFee, totalAmount };
};

// Handle preflight OPTIONS requests
app.options('*', cors(corsOptions));

app.use(express.json());

// Routes
app.get('/api/health', async (req, res) => {
  try {
    const status = {
      status: 'OK',
      message: 'Server is running',
      timestamp: new Date().toISOString(),
      stripeInitialized: !!stripe,
      mongoConnected: mongoose.connection.readyState === 1
    };
    console.log('Health check:', status);
    res.json(status);
  } catch (error) {
    console.error('Health check error:', error.message);
    res.status(500).json({ error: 'Health check failed', message: error.message });
  }
});

app.get('/api/create-test-entry/:userId', async (req, res) => {
  try {
    await connectDB();
    const userId = req.params.userId;
    const entry = new Entry({
      userId,
      category: 'business',
      entryType: 'text',
      title: 'Sample Business Strategy Entry',
      description: 'A comprehensive business strategy for digital transformation in modern enterprises',
      textContent: 'This is a detailed business strategy focusing on digital transformation in modern enterprises. The strategy encompasses multiple aspects of organizational change, technology adoption, and market positioning. It addresses the challenges of legacy system migration, workforce adaptation, and competitive differentiation in an increasingly digital marketplace. The approach emphasizes customer-centric design, agile methodologies, and data-driven decision making to ensure sustainable growth and market leadership.'.repeat(2),
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
    console.error('Error creating test entry:', error.message);
    res.status(500).json({ error: 'Failed to create test entry', message: error.message });
  }
});

app.get('/api/create-test-entries/:userId', async (req, res) => {
  try {
    await connectDB();
    const userId = req.params.userId;
    const testEntries = [
      {
        userId,
        category: 'business',
        entryType: 'text',
        title: 'Innovative Business Strategy',
        description: 'A comprehensive business strategy for modern markets',
        textContent: 'This business strategy focuses on digital transformation in the modern marketplace. It encompasses comprehensive market analysis, competitive positioning, and strategic roadmap development. The approach integrates customer experience optimization, operational efficiency improvements, and technology-driven innovation to create sustainable competitive advantages. Key focus areas include digital channel optimization, data analytics implementation, and agile organizational transformation. The strategy addresses market disruption challenges while identifying new growth opportunities through strategic partnerships and emerging technology adoption.'.repeat(2),
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
        fileData: 'data:application/pdf;base64,JVBERi0xLjQKJcOkw7zDtsO8CjIgMCBvYmoKPDwKL0xlbmd0aCAzIDAgUgo+PgpzdHJlYW0KQNC/wqfDtsKyw6bCp8Ozw7bDvMOkw7zDvsO4w7bCqsOkw7zDtsKuw6fCqcK6w7LDuMOsw7bCtcKqw7XCtcOkw7fCusO3w7bCtcKqw7XCusOzw7bCrcKqw6vCusO3w7bDusK8w7bCtcO7w7bDvMOsw7bCrcKqw6vDusOzw6jCvMO8w7bCtcKqw7XCtcOzw7bDtcO7w7bDuMK8w6fCqcK6w7LDtMOqw7bCtcK6w7bCtcOzw6bCqMK7w7bCtcK6w7fCusOzw7bCtcO7w7bDtcOmwqjCu8K6w6fCusOzw7bCrsKqw6vCusOzCmVuZHN0cmVhbQplbmRvYmoKCjMgMCBvYmoKMzUKZW5kb2JqCgo0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9QYXJlbnQgMSAwIFIKL01lZGlhQm94IFswIDAgNjEyIDc5Ml0KL0NvbnRlbnRzIDIgMCBSCj4+CmVuZG9iagoKMSAwIG9iago8PAovVHlwZSAvUGFnZXMKL0tpZHMgWzQgMCBSXQovQ291bnQgMQo+PgplbmRvYmoKCjUgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCj4+CmVuZG9iagoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMTczIDAwMDAwIG4gCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA4MyAwMDAwMCBuIAowMDAwMDAwMTAzIDAwMDAwIG4gCjAwMDAwMDAyMjkgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA2Ci9Sb290IDUgMCBSCj4+CnN0YXJ0eHJlZgoyNzgKJSVFT0YK', // Sample PDF base64
        fileName: 'ai-solution-pitch.pdf',
        fileMimeType: 'application/pdf',
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
      entries: savedEntries.map(e => ({ id: e._id, title: e.title, status: e.status }))
    });
  } catch (error) {
    console.error('Error creating test entries:', error.message);
    res.status(500).json({ error: 'Failed to create test entries', message: error.message });
  }
});

app.post('/api/create-payment-intent', async (req, res) => {
  try {
    if (!stripe) {
      throw new Error('Stripe is not initialized. Check STRIPE_SECRET_KEY configuration.');
    }
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
    console.error('Error creating payment intent:', error.message);
    res.status(500).json({ 
      error: 'Failed to create payment intent',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.post('/api/entries', upload.single('file'), async (req, res) => {
  try {
    await connectDB();
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

    if (!stripe) {
      throw new Error('Stripe is not initialized. Check STRIPE_SECRET_KEY configuration.');
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
      // Convert file to base64 for storage in database (serverless compatible)
      entryData.fileData = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
      entryData.fileName = req.file.originalname;
      entryData.fileMimeType = req.file.mimetype;
    } else if (entryType === 'video') {
      entryData.videoUrl = videoUrl;
    }
    
    console.log('Creating entry with data:', { ...entryData, fileData: entryData.fileData ? '[FILE_DATA]' : undefined });
    const entry = new Entry(entryData);
    await entry.save();
    console.log('Entry created successfully:', entry._id);
    res.status(201).json({ message: 'Entry submitted successfully', entryId: entry._id });
  } catch (error) {
    console.error('Error submitting entry:', error.message);
    res.status(500).json({ 
      error: 'Failed to submit entry',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.get('/api/entries/:userId', async (req, res) => {
  try {
    await connectDB();
    console.log('Fetching entries for user:', req.params.userId);
    const entries = await Entry.find({ userId: req.params.userId })
      .select('-fileData') // Exclude large file data from list view
      .sort({ createdAt: -1 });
    console.log(`Found ${entries.length} entries for user:`, req.params.userId);
    res.json(entries);
  } catch (error) {
    console.error('Error fetching entries:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch entries',
      message: error.message
    });
  }
});

app.get('/api/entry/:id', async (req, res) => {
  try {
    await connectDB();
    const entry = await Entry.findById(req.params.id);
    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }
    res.json(entry);
  } catch (error) {
    console.error('Error fetching entry:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch entry',
      message: error.message
    });
  }
});

// New endpoint to download files (converts base64 back to file)
app.get('/api/entry/:id/download', async (req, res) => {
  try {
    await connectDB();
    const entry = await Entry.findById(req.params.id);
    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }
    
    if (!entry.fileData) {
      return res.status(404).json({ error: 'No file associated with this entry' });
    }
    
    // Extract base64 data
    const base64Data = entry.fileData.split(',')[1];
    const buffer = Buffer.from(base64Data, 'base64');
    
    res.setHeader('Content-Type', entry.fileMimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${entry.fileName}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Error downloading file:', error.message);
    res.status(500).json({ 
      error: 'Failed to download file',
      message: error.message
    });
  }
});

app.delete('/api/entries/:id', async (req, res) => {
  try {
    await connectDB();
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
    console.error('Error deleting entry:', error.message);
    res.status(500).json({ 
      error: 'Failed to delete entry',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  try {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      throw new Error('STRIPE_WEBHOOK_SECRET not configured');
    }
    if (!stripe) {
      throw new Error('Stripe is not initialized');
    }
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    if (event.type === 'payment_intent.payment_failed') {
      await connectDB();
      const paymentIntent = event.data.object;
      await Entry.findOneAndUpdate(
        { paymentIntentId: paymentIntent.id },
        { paymentStatus: 'failed' }
      );
      console.log('Updated payment status to failed for paymentIntent:', paymentIntent.id);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error.message);
  res.status(500).json({
    error: 'Internal server error',
    message: error.message,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
  });
});

// Export for Vercel
module.exports = app;
