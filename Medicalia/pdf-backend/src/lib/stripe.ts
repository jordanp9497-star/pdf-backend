/**
 * Client Stripe
 * 
 * Client Stripe configuré avec la clé secrète
 */

import Stripe from 'stripe';
import { STRIPE_CONFIG } from '../config/env.js';

export const stripe = new Stripe(STRIPE_CONFIG.secretKey, {
  apiVersion: '2024-06-20',
});

console.log('[STRIPE] ✅ Client initialisé');
