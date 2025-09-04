import React, { useState, useEffect } from 'react';
import { Elements } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import EntryForm from './components/EntryForm';
import EntryList from './components/EntryList';
import './App.css';

// Initialize Stripe with the publishable key
const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY);

function App() {
  const [currentView, setCurrentView] = useState('submit');
  const [userId] = useState(() => {
    let storedUserId = localStorage.getItem('top216_user_id');
    if (!storedUserId) {
      storedUserId = 'user_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
      localStorage.setItem('top216_user_id', storedUserId);
    }
    return storedUserId;
  });

  useEffect(() => {


  console.log('Stripe Publishable Key:', import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY);

    console.log('=== App Initialization ===');
    console.log('User ID:', userId);
    console.log('VITE_API_URL:', import.meta.env.VITE_API_URL || 'http://localhost:5000');
    console.log('VITE_STRIPE_PUBLISHABLE_KEY:', import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ? 'Set' : 'Not set');
  }, [userId]);

  const handleCreateTestEntry = async () => {
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/create-test-entry/${userId}`);
      const data = await response.json();
      if (response.ok) {
        alert(`Test entry created successfully! Entry ID: ${data.id}`);
        if (currentView === 'entries') {
          window.location.reload();
        } else {
          setCurrentView('entries');
        }
      } else {
        alert('Failed to create test entry: ' + data.error);
      }
    } catch (error) {
      console.error('Error creating test entry:', error);
      alert('Failed to create test entry');
    }
  };

  const handleCreateMultipleTestEntries = async () => {
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/create-test-entries/${userId}`);
      const data = await response.json();
      if (response.ok) {
        alert(`${data.entries.length} test entries created successfully!`);
        if (currentView === 'entries') {
          window.location.reload();
        } else {
          setCurrentView('entries');
        }
      } else {
        alert('Failed to create test entries: ' + data.error);
      }
    } catch (error) {
      console.error('Error creating test entries:', error);
      alert('Failed to create test entries');
    }
  };

  return (
    <Elements stripe={stripePromise}>
      <div className='overflow-hidden bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-800'>
      <div className="min-h-screen overflow-hidden bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-800">
        <header className="overflow-hidden bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-800 shadow-sm text-white">
          <div className="max-w-4xl mx-auto px-4 py-6">
            <div className="flex justify-between items-start ">
              <div className=''>
                <h1 className="text-5xl md:text-6xl font-bold mb-4 tracking-tight text-yellow-300">Top216.com</h1>
                <p className="text-white mt-2">Global competition platform for professionals and creators submit entries across categories</p>
              </div>
              <div className="text-right text-sm text-white">
                <p>User ID: {userId.substring(0, 12)}...</p>
                <p className="text-xs">Test Environment</p>
              </div>
            </div>
            <nav className="mt-6 ">
              <div className="flex flex-wrap items-center justify-between">
                <div className="flex space-x-4 ">
                  <button
                    onClick={() => setCurrentView('submit')}
                    className={`px-4 py-2 rounded-md font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors ${
                      currentView === 'submit' 
                        ? 'bg-blue-600 text-white' 
                        : 'text-white hover:text-gray-900 hover:bg-gray-100'
                    }`}
                  >
                    Submit Entry
                  </button>
                  <button
                    onClick={() => setCurrentView('entries')}
                    className={`px-4 py-2 rounded-md font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors ${
                      currentView === 'entries' 
                        ? 'bg-blue-600 text-white' 
                        : 'text-white hover:text-gray-900 hover:bg-gray-100'
                    }`}
                  >
                    My Entries
                  </button>
                </div>
                <div className="flex space-x-2 mt-4 md:mt-0">
      
                  
                </div>
              </div>
            </nav>
          </div>
        </header>
       
        <main className="max-w-4xl mx-auto px-4 py-8">
          
            {currentView === 'submit' ? (
    <>
      <div className="mb-6 text-white text-2xl font-semibold">Welcome to<span className='text-yellow-300'> Top216.com </span> - A global competition platform</div>
      <EntryForm userId={userId} />
    </>
  ) : (
    <EntryList userId={userId} />
  )}
  
        </main>
        <footer className="bg-black border-t mt-16">
          <div className="max-w-4xl mx-auto px-4 py-8">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div>
                <h4 className="font-semibold text-white mb-2">Competition Categories</h4>
                <ul className="text-sm text-white space-y-1">
                  <li>• Business - $49</li>
                  <li>• Creative - $49</li>
                  <li>• Technology - $99</li>
                  <li>• Social Impact - $49</li>
                </ul>
              </div>
              <div>
                <h4 className="font-semibold text-white mb-2">Entry Types</h4>
                <ul className="text-sm text-white space-y-1">
                  <li>• Text (100-2000 words)</li>
                  <li>• Pitch Deck (PDF/PPT, max 25MB)</li>
                  <li>• Video (YouTube/Vimeo link)</li>
                </ul>
              </div>
              <div>
                <h4 className="font-semibold text-white mb-2">System Status</h4>
                <ul className="text-sm text-white space-y-1">
                  <li>✅ MongoDB Connected</li>
                  <li>✅ Stripe Test Mode</li>
                  <li>✅ File Upload Ready</li>
                  <li>✅ Payment Processing</li>
                </ul>
              </div>
            </div>
            <div className="mt-8 pt-8 border-t text-center text-sm text-white">
              <p>&copy; 2025 Top216.com - Global Competition Platform</p>
              
            </div>
            
          </div>
        </footer>
      </div>
      </div>
    </Elements>
  );
}

export default App;