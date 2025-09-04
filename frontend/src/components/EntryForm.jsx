import React, { useState, useEffect } from 'react';
import { useStripe, useElements, CardElement } from '@stripe/react-stripe-js';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

const cardElementOptions = {
  style: {
    base: {
      fontSize: '16px',
      color: '#32325d',
      '::placeholder': { color: '#aab7c4' },
    },
    invalid: { color: '#fa755a' },
  },
};

const EntryForm = ({ userId }) => {
  const stripe = useStripe();
  const elements = useElements();
  const [formData, setFormData] = useState({
    category: '',
    entryType: '',
    title: '',
    description: '',
    textContent: '',
    videoUrl: '',
    file: null
  });
  const [fees, setFees] = useState({
    entryFee: 0,
    stripeFee: 0,
    totalAmount: 0
  });
  const [clientSecret, setClientSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [step, setStep] = useState(1);
  const [stripeLoaded, setStripeLoaded] = useState(false);

  useEffect(() => {
    if (stripe && elements) {
      setStripeLoaded(true);
      console.log('Stripe loaded successfully');
    }
  }, [stripe, elements]);

  const categories = [
    { value: 'business', label: 'Business', fee: 49 },
    { value: 'creative', label: 'Creative', fee: 49 },
    { value: 'technology', label: 'Technology', fee: 99 },
    { value: 'social-impact', label: 'Social Impact', fee: 49 }
  ];

  const entryTypes = [
    { value: 'text', label: 'Text Entry (100-2000 words)' },
    { value: 'pitch-deck', label: 'Pitch Deck (PDF/PPT, max 25MB)' },
    { value: 'video', label: 'Video (YouTube/Vimeo link)' }
  ];

  const handleCategoryChange = async (category) => {
    setFormData(prev => ({ ...prev, category }));
    if (category && formData.entryType) {
      try {
        const response = await fetch(`${API_BASE_URL}/api/create-payment-intent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category, entryType: formData.entryType }),
        });
        if (!response.ok) {
          throw new Error('Failed to calculate fees');
        }
        const data = await response.json();
        setFees({ entryFee: data.entryFee, stripeFee: data.stripeFee, totalAmount: data.totalAmount });
        setClientSecret(data.clientSecret);
      } catch (err) {
        setError('Failed to calculate fees: ' + err.message);
      }
    }
  };

  const handleInputChange = (e) => {
    const { name, value, files } = e.target;
    if (name === 'file') {
      setFormData(prev => ({ ...prev, file: files[0] }));
    } else {
      setFormData(prev => ({ ...prev, [name]: value }));
    }
    if (name === 'category') {
      handleCategoryChange(value);
    } else if (name === 'entryType' && formData.category) {
      handleCategoryChange(formData.category);
    }
  };

  const validateForm = () => {
    const { category, entryType, title, textContent, videoUrl, file } = formData;
    if (!category || !entryType || !title.trim()) {
      setError('Please fill in all required fields');
      return false;
    }
    if (title.length < 5 || title.length > 100) {
      setError('Title must be between 5-100 characters');
      return false;
    }
    if (entryType === 'text') {
      if (!textContent.trim()) {
        setError('Text content is required for text entries');
        return false;
      }
      const wordCount = textContent.trim().split(/\s+/).filter(word => word.length > 0).length;
      if (wordCount < 100 || wordCount > 2000) {
        setError(`Text entries must be between 100-2000 words. Current: ${wordCount} words`);
        return false;
      }
    }
    if (entryType === 'pitch-deck' && !file) {
      setError('Please upload a pitch deck file');
      return false;
    }
    if (entryType === 'pitch-deck' && file) {
      const maxSize = 25 * 1024 * 1024;
      if (file.size > maxSize) {
        setError('File size must be less than 25MB');
        return false;
      }
      const allowedTypes = ['application/pdf', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'];
      if (!allowedTypes.includes(file.type)) {
        setError('Only PDF, PPT, and PPTX files are allowed');
        return false;
      }
    }
    if (entryType === 'video') {
      if (!videoUrl.trim()) {
        setError('Video URL is required for video entries');
        return false;
      }
      const urlPattern = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|vimeo\.com)/i;
      if (!urlPattern.test(videoUrl)) {
        setError('Please provide a valid YouTube or Vimeo URL');
        return false;
      }
    }
    return true;
  };

  const handleFormSubmit = async (e) => {
    e.preventDefault();
    if (!validateForm()) return;
    if (!stripe) {
      setError('Stripe is not loaded yet. Please wait and try again.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/create-payment-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: formData.category, entryType: formData.entryType }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create payment intent');
      }
      const data = await response.json();
      setFees({ entryFee: data.entryFee, stripeFee: data.stripeFee, totalAmount: data.totalAmount });
      setClientSecret(data.clientSecret);
      setStep(2);
    } catch (err) {
      setError('Failed to initialize payment: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePaymentSubmit = async (e) => {
    e.preventDefault();
    if (!stripe || !elements || !clientSecret) {
      setError('Payment system not ready. Please refresh and try again.');
      return;
    }
    setLoading(true);
    setError('');
    const cardElement = elements.getElement(CardElement);
    const { error: paymentError, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
      payment_method: { card: cardElement },
    });
    if (paymentError) {
      setError(paymentError.message);
      setLoading(false);
      return;
    }
    try {
      const submitData = new FormData();
      submitData.append('userId', userId);
      submitData.append('category', formData.category);
      submitData.append('entryType', formData.entryType);
      submitData.append('title', formData.title);
      submitData.append('description', formData.description);
      submitData.append('paymentIntentId', paymentIntent.id);
      if (formData.entryType === 'text') {
        submitData.append('textContent', formData.textContent);
      } else if (formData.entryType === 'pitch-deck' && formData.file) {
        submitData.append('file', formData.file);
      } else if (formData.entryType === 'video') {
        submitData.append('videoUrl', formData.videoUrl);
      }
      const response = await fetch(`${API_BASE_URL}/api/entries`, {
        method: 'POST',
        body: submitData,
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to submit entry');
      }
      const data = await response.json();
      setSuccess('Entry submitted successfully! Entry ID: ' + data.entryId);
      setFormData({
        category: '',
        entryType: '',
        title: '',
        description: '',
        textContent: '',
        videoUrl: '',
        file: null
      });
      setFees({ entryFee: 0, stripeFee: 0, totalAmount: 0 });
      setClientSecret('');
      setStep(1);
    } catch (err) {
      setError('Failed to submit entry: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-8">
      {success && (
        <div className="mb-6 p-4 bg-green-100 text-green-700 rounded-md">
          {success}
          <button
            onClick={() => setSuccess('')}
            className="ml-4 text-sm text-green-900 underline"
          >
            Close
          </button>
        </div>
      )}
      {error && (
        <div className="mb-6 p-4 bg-red-100 text-red-700 rounded-md">
          {error}
          <button
            onClick={() => setError('')}
            className="ml-4 text-sm text-red-900 underline"
          >
            Close
          </button>
        </div>
      )}
      {step === 1 && (
        <form onSubmit={handleFormSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Category *</label>
            <select
              name="category"
              value={formData.category}
              onChange={handleInputChange}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              required
            >
              <option value="">Select a category</option>
              {categories.map(cat => (
                <option key={cat.value} value={cat.value}>{cat.label} (${cat.fee})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Entry Type *</label>
            <select
              name="entryType"
              value={formData.entryType}
              onChange={handleInputChange}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              required
            >
              <option value="">Select an entry type</option>
              {entryTypes.map(type => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Title *</label>
            <input
              type="text"
              name="title"
              value={formData.title}
              onChange={handleInputChange}
              placeholder="Enter your entry title"
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              required
            />
            <p className="mt-1 text-xs text-gray-500">{formData.title.length}/100 characters</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
            <textarea
              name="description"
              value={formData.description}
              onChange={handleInputChange}
              placeholder="Enter a brief description (optional, max 500 characters)"
              rows={4}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            />
            <p className="mt-1 text-xs text-gray-500">{formData.description.length}/500 characters</p>
          </div>
          {formData.entryType === 'text' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Text Content *</label>
              <textarea
                name="textContent"
                value={formData.textContent}
                onChange={handleInputChange}
                placeholder="Enter your text content here (100-2000 words)"
                rows={10}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                required
              />
              {formData.textContent && (
                <p className="mt-1 text-xs text-gray-500">
                  Word count: {formData.textContent.trim().split(/\s+/).filter(word => word.length > 0).length} words
                </p>
              )}
            </div>
          )}
          {formData.entryType === 'pitch-deck' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Upload Pitch Deck *</label>
              <input
                type="file"
                name="file"
                onChange={handleInputChange}
                accept=".pdf,.ppt,.pptx"
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                required
              />
              <p className="mt-1 text-xs text-gray-500">Accepted formats: PDF, PPT, PPTX (max 25MB)</p>
            </div>
          )}
          {formData.entryType === 'video' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Video URL *</label>
              <input
                type="url"
                name="videoUrl"
                value={formData.videoUrl}
                onChange={handleInputChange}
                placeholder="https://youtube.com/watch?v=... or https://vimeo.com/..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                required
              />
              <p className="mt-1 text-xs text-gray-500">YouTube and Vimeo links only</p>
            </div>
          )}
          {fees.totalAmount > 0 && (
            <div className="bg-gray-50 rounded-md p-4">
              <h3 className="text-lg font-medium text-gray-900 mb-2">Fee Summary</h3>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span>Entry Fee:</span>
                  <span>${fees.entryFee.toFixed(2)}</span> {/* Fixed: Removed /100 */}
                </div>
                <div className="flex justify-between">
                  <span>Processing Fee:</span>
                  <span>${fees.stripeFee.toFixed(2)}</span> {/* Fixed: Removed /100 */}
                </div>
                <div className="flex justify-between font-medium pt-1 border-t">
                  <span>Total:</span>
                  <span>${fees.totalAmount.toFixed(2)}</span> {/* Fixed: Removed /100 */}
                </div>
              </div>
            </div>
          )}
          <div className="flex justify-end space-x-4">
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center px-6 py-3 border border-transparent rounded-md shadow-sm text-base font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading && (
                <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              )}
              {loading ? 'Processing...' : 'Continue to Payment'}
            </button>
          </div>
        </form>
      )}

      {step === 2 && (
  <form onSubmit={handlePaymentSubmit} className="space-y-6">
    <div className="bg-gray-50 rounded-md p-4 mb-6">
      <h3 className="text-lg font-medium text-gray-900 mb-2">Entry Summary</h3>
      <div className="space-y-1 text-sm">
        <div><span className="font-medium">Category:</span> {categories.find(c => c.value === formData.category)?.label}</div>
        <div><span className="font-medium">Type:</span> {entryTypes.find(t => t.value === formData.entryType)?.label}</div>
        <div><span className="font-medium">Title:</span> {formData.title}</div>
      </div>
    </div>
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">Card Information</label>
      <div className="p-3 border border-gray-300 rounded-md mb-2">
        <CardElement options={cardElementOptions} />
      </div>
      <div className="text-sm text-gray-500">
        <p>Use test card <code className="bg-gray-100 px-1 rounded">4242 4242 4242 4242</code></p>
        <p>12/28 (M/Y)</p>
        <p>123 (CVC)</p>
        <p>10001 (ZIP)</p>
        <p className="text-xs mt-1">For test payments only.</p>
      </div>
    </div>
    <div className="bg-gray-50 rounded-md p-4">
      <h3 className="text-lg font-medium text-gray-900 mb-2">Payment Summary</h3>
      <div className="space-y-1 text-sm">
        <div className="flex justify-between">
          <span>Entry Fee:</span>
          <span>${fees.entryFee.toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span>Processing Fee:</span>
          <span>${fees.stripeFee.toFixed(2)}</span>
        </div>
        <div className="flex justify-between font-medium text-lg pt-2 border-t">
          <span>Total:</span>
          <span>${fees.totalAmount.toFixed(2)}</span>
        </div>
      </div>
    </div>
    <div className="flex justify-between">
      <button
        type="button"
        onClick={() => setStep(1)}
        className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
      >
        Back to Entry Details
      </button>
      <button
        type="submit"
        disabled={loading || !stripe}
        className="inline-flex items-center px-6 py-3 border border-transparent rounded-md shadow-sm text-base font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading && (
          <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        )}
        {loading ? 'Processing Payment...' : `Pay $${fees.totalAmount.toFixed(2)}`}
      </button>
    </div>
  </form>
)}
    </div>
  );
};

export default EntryForm;