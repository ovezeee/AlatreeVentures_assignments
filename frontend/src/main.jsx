import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './App.css';
import { Elements } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import App from './App.jsx';

// Hardcode the Stripe publishable key directly
const stripePromise = loadStripe('pk_test_51RzCNtCbNv8AUZxiWD1dCDYRm5KZ8D8uFx6xDcGP94egfmYEjx3hUCQEAs1V2Nx8M687QEfcUYVQ4BLSSQJSBH00j1N4STjSH');

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Elements stripe={stripePromise}>
      <App />
    </Elements>
  </StrictMode>,
);