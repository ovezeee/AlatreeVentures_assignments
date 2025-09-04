
import React, { useState, useEffect } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

const EntryList = ({ userId }) => {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchEntries();
  }, [userId]);

  const fetchEntries = async () => {
    try {
      setLoading(true);
      console.log('Fetching entries for userId:', userId);
      const response = await fetch(`${API_BASE_URL}/api/entries/${userId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch entries');
      }
      const data = await response.json();
      console.log('Fetched entries:', data);
      setEntries(data);
      setError('');
    } catch (error) {
      console.error('Error fetching entries:', error);
      setError('Failed to load entries. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteEntry = async (entryId) => {
    if (!window.confirm('Are you sure you want to delete this entry? This action cannot be undone.')) {
      return;
    }
    try {
      setLoading(true);
      const response = await fetch(`${API_BASE_URL}/api/entries/${entryId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to delete entry');
      }
      setEntries(entries.filter(entry => entry._id !== entryId));
      setError('');
    } catch (error) {
      console.error('Error deleting entry:', error);
      setError('Failed to delete entry: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status) => {
    const colors = {
      'submitted': 'bg-blue-100 text-blue-800',
      'under-review': 'bg-yellow-100 text-yellow-800',
      'finalist': 'bg-green-100 text-green-800',
      'winner': 'bg-purple-100 text-purple-800',
      'rejected': 'bg-red-100 text-red-800'
    };
    return colors[status] || 'bg-gray-100 text-gray-800';
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'submitted': return '📝';
      case 'under-review': return '👀';
      case 'finalist': return '🏆';
      case 'winner': return '🥇';
      case 'rejected': return '❌';
      default: return '🚀';
    }
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const EntryModal = ({ entry, onClose }) => {
    if (!entry) return null;
    return (
      <div className="fixed inset-0 bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-800 flex items-center justify-center p-4 z-50">
        <div className="bg-white rounded-lg max-w-4xl max-h-screen overflow-y-auto w-full">
          <div className="p-6">
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-2xl font-bold text-gray-900">{entry.title}</h2>
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-gray-600 text-2xl font-bold leading-none"
              >
                ×
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6 text-sm">
              <div>
                <span className="font-medium text-gray-700">Category:</span>
                <span className="ml-2 capitalize">{entry.category.replace('-', ' ')}</span>
              </div>
              <div>
                <span className="font-medium text-gray-700">Type:</span>
                <span className="ml-2 capitalize">{entry.entryType.replace('-', ' ')}</span>
              </div>
              <div>
                <span className="font-medium text-gray-700">Status:</span>
                <span className={`ml-2 px-2 py-1 rounded-full text-xs ${getStatusColor(entry.status)}`}>
                  {getStatusIcon(entry.status)} {entry.status.replace('-', ' ')}
                </span>
              </div>
              <div>
                <span className="font-medium text-gray-700">Submitted:</span>
                <span className="ml-2">{formatDate(entry.submissionDate)}</span>
              </div>
            </div>
            {entry.description && (
              <div className="mb-4">
                <h3 className="font-medium text-gray-700 mb-2">Description</h3>
                <p className="text-gray-600 bg-gray-50 p-3 rounded-md">{entry.description}</p>
              </div>
            )}
            {entry.entryType === 'text' && entry.textContent && (
              <div className="mb-4">
                <h3 className="font-medium text-gray-700 mb-2">Content</h3>
                <div className="bg-gray-50 p-4 rounded-md max-h-96 overflow-y-auto">
                  <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans">{entry.textContent}</pre>
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  Word count: {entry.textContent.split(/\s+/).filter(word => word.length > 0).length}
                </p>
              </div>
            )}
            {entry.entryType === 'pitch-deck' && entry.fileUrl && (
              <div className="mb-4">
                <h3 className="font-medium text-gray-700 mb-2">Pitch Deck</h3>
                <a
                  href={`${API_BASE_URL}${entry.fileUrl}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  📄 Open File
                </a>
              </div>
            )}
            {entry.entryType === 'video' && entry.videoUrl && (
              <div className="mb-4">
                <h3 className="font-medium text-gray-700 mb-2">Video</h3>
                <a
                  href={entry.videoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500"
                >
                  🎥 Watch Video
                </a>
              </div>
            )}
            <div className="bg-gray-50 p-4 rounded-md border">
              <h3 className="font-medium text-gray-700 mb-2">Payment Details</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-600">Entry Fee:</span>
                  <span className="ml-2 font-medium">${entry.entryFee.toFixed(2)}</span>
                </div>
                <div>
                  <span className="text-gray-600">Processing Fee:</span>
                  <span className="ml-2 font-medium">${entry.stripeFee.toFixed(2)}</span>
                </div>
                <div>
                  <span className="text-gray-600">Total Paid:</span>
                  <span className="ml-2 font-medium text-green-600">${entry.totalAmount.toFixed(2)}</span>
                </div>
                <div>
                  <span className="text-gray-600">Payment Status:</span>
                  <span className={`ml-2 px-2 py-1 rounded-full text-xs ${
                    entry.paymentStatus === 'succeeded' ? 'bg-green-100 text-green-800' : 
                    entry.paymentStatus === 'failed' ? 'bg-red-100 text-red-800' : 
                    'bg-yellow-100 text-yellow-800'
                  }`}>
                    {entry.paymentStatus}
                  </span>
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 bg-gray-300 text-gray-700 rounded-md hover:bg-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-500"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow-md p-8">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading your entries...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow-md p-8">
        <div className="text-center">
          <div className="text-red-600 mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 18.5c-.77.833.192 2.5 1.732 2.5z"></path>
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Error Loading Entries</h2>
          <p className="text-gray-600 mb-6">{error}</p>
          <button
            onClick={fetchEntries}
            className="bg-blue-600 text-white px-6 py-2 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-md p-8">
        <div className="text-center">
          <div className="text-gray-400 mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-4">No Entries Yet</h2>
          <p className="text-gray-600 mb-6">You haven't submitted any entries to Top216.com competitions.</p>
          <p className="text-gray-500">Submit your first entry to get started!</p>
          <div className="mt-6">
            <p className="text-sm text-blue-600">
              💡 <strong>Tip:</strong> Try creating a test entry using Stripe test card: 
              4242 4242 4242 4242
             
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="bg-white rounded-lg shadow-md p-8">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-gray-900">My Entries ({entries.length})</h2>
          <button
            onClick={fetchEntries}
            className="text-blue-600 hover:text-blue-800 text-sm font-medium"
          >
            🔄 Refresh
          </button>
        </div>
        <div className="space-y-4">
          {entries.map((entry) => (
            <div
              key={entry._id}
              className="border border-gray-200 rounded-lg p-6 hover:shadow-md hover:border-blue-300 transition-all cursor-pointer"
              onClick={() => setSelectedEntry(entry)}
            >
              <div className="flex justify-between items-start mb-4">
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">{entry.title}</h3>
                  <div className="flex flex-wrap gap-4 text-sm text-gray-600">
                    <span className="capitalize">📂 {entry.category.replace('-', ' ')}</span>
                    <span>•</span>
                    <span className="capitalize">📝 {entry.entryType.replace('-', ' ')}</span>
                    <span>•</span>
                    <span>🗓️ {formatDate(entry.submissionDate)}</span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span className={`px-3 py-1 rounded-full text-xs font-medium ${getStatusColor(entry.status)}`}>
                    {getStatusIcon(entry.status)} {entry.status.replace('-', ' ')}
                  </span>
                  <span className="text-sm font-medium text-green-600">${entry.totalAmount.toFixed(2)}</span>
                </div>
              </div>
              {entry.description && (
                <p className="text-gray-600 text-sm mb-4 line-clamp-2">{entry.description}</p>
              )}
              <div className="flex justify-between items-center text-sm">
                <div className="flex items-center gap-4">
                  {entry.entryType === 'text' && (
                    <span className="text-gray-500">
                      📄 {entry.textContent ? `${entry.textContent.split(/\s+/).filter(word => word.length > 0).length} words` : 'No content'}
                    </span>
                  )}
                  {entry.entryType === 'pitch-deck' && (
                    <span className="text-blue-600">📁 File uploaded</span>
                  )}
                  {entry.entryType === 'video' && (
                    <span className="text-red-600">🎥 Video linked</span>
                  )}
                  <span className={`px-2 py-1 rounded-full text-xs ${
                    entry.paymentStatus === 'succeeded' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                  }`}>
                    💳 {entry.paymentStatus}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-blue-600 hover:text-blue-800 font-medium flex items-center">
                    View Details →
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation(); // Prevent triggering the card click
                      handleDeleteEntry(entry._id);
                    }}
                    className="text-red-600 hover:text-red-800 font-medium flex items-center"
                  >
                    🗑️ Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <EntryModal entry={selectedEntry} onClose={() => setSelectedEntry(null)} />
    </>
  );
};

export default EntryList;
