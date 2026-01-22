/**
 * Configuration centralisée des variables d'environnement
 * 
 * Valide toutes les variables requises au démarrage
 * Utilise dotenv uniquement en développement
 */

import dotenv from 'dotenv';

// Charger .env uniquement en développement (si fichier présent)
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

/**
 * Masque une clé pour les logs (affiche les 4 premiers et 4 derniers caractères)
 */
function maskKey(key: string | undefined): string {
  if (!key) return 'undefined';
  if (key.length <= 8) return 'xxxx';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/**
 * Valide qu'une variable d'environnement est présente
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`❌ Variable d'environnement manquante: ${name}`);
  }
  return value;
}

/**
 * Configuration Supabase
 */
export const SUPABASE_CONFIG = {
  url: requireEnv('SUPABASE_URL'),
  serviceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  jwtJwksUrl: process.env.SUPABASE_JWT_JWKS_URL || 
    `${requireEnv('SUPABASE_URL')}/.well-known/jwks.json`,
} as const;

/**
 * Configuration Stripe
 */
export const STRIPE_CONFIG = {
  secretKey: requireEnv('STRIPE_SECRET_KEY'),
  webhookSecret: requireEnv('STRIPE_WEBHOOK_SECRET'),
  priceId: requireEnv('STRIPE_PRICE_ID'),
} as const;

/**
 * Configuration de l'application
 */
export const APP_CONFIG = {
  baseUrl: requireEnv('APP_BASE_URL'),
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
} as const;

/**
 * Logs sécurisés au démarrage (sans exposer les clés complètes)
 */
export function logEnvStatus() {
  console.log('[ENV] SUPABASE_URL present:', !!SUPABASE_CONFIG.url);
  console.log('[ENV] SUPABASE_SERVICE_ROLE_KEY present:', !!SUPABASE_CONFIG.serviceRoleKey, 
    `(masked: ${maskKey(SUPABASE_CONFIG.serviceRoleKey)})`);
  console.log('[ENV] SUPABASE_JWT_JWKS_URL:', SUPABASE_CONFIG.jwtJwksUrl);
  
  console.log('[ENV] STRIPE_SECRET_KEY present:', !!STRIPE_CONFIG.secretKey,
    `(masked: ${maskKey(STRIPE_CONFIG.secretKey)})`);
  console.log('[ENV] STRIPE_WEBHOOK_SECRET present:', !!STRIPE_CONFIG.webhookSecret,
    `(masked: ${maskKey(STRIPE_CONFIG.webhookSecret)})`);
  console.log('[ENV] STRIPE_PRICE_ID present:', !!STRIPE_CONFIG.priceId);
  
  console.log('[ENV] APP_BASE_URL:', APP_CONFIG.baseUrl);
  console.log('[ENV] NODE_ENV:', APP_CONFIG.nodeEnv);
  console.log('[ENV] PORT:', APP_CONFIG.port);
}

// Valider toutes les variables au chargement du module
try {
  // Les requireEnv() ci-dessus vont throw si manquantes
  console.log('[ENV] ✅ Toutes les variables d\'environnement requises sont présentes');
} catch (error) {
  console.error('[ENV] ❌ Erreur de configuration:', error instanceof Error ? error.message : error);
  throw error;
}
