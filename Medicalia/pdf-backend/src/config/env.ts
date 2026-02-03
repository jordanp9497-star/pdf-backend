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
 * Variable d'environnement optionnelle.
 */
function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
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
 * Configuration N8N (webhooks OCR)
 */
export const N8N_CONFIG = {
  webhookUrl: requireEnv('N8N_WEBHOOK_URL'),
  ocrWebhookUrl: requireEnv('N8N_OCR_WEBHOOK_URL'),
} as const;

/**
 * Configuration AI (URLs des APIs)
 */
export const AI_CONFIG = {
  mistralApiUrl: process.env.MISTRAL_API_URL || 'https://api.mistral.ai/v1/chat/completions',
  openaiApiUrl: process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions',
  mistralApiKey: requireEnv('MISTRAL_API_KEY'),
  // OpenAI désactivé: ne pas exiger la clé
  openaiApiKey: optionalEnv('OPENAI_API_KEY'),
} as const;

/**
 * Configuration URLs publiques
 */
export const PUBLIC_WEB_CONFIG = {
  baseUrl: process.env.PUBLIC_WEB_BASE_URL || 'https://medicalia.app',
} as const;

/**
 * Détermine le type de clé Supabase (anon ou service_role)
 */
function getSupabaseKeyType(key: string | undefined, envVarName: string): string {
  if (!key) return 'none';
  // Détecter via le nom de la variable d'environnement
  if (envVarName.includes('ANON') || envVarName.includes('anon')) return 'anon';
  if (envVarName.includes('SERVICE_ROLE') || envVarName.includes('service_role')) return 'service_role';
  // Détecter via la longueur (les clés anon sont généralement plus courtes)
  // Les clés service_role commencent souvent par "eyJ..." et sont plus longues
  if (key.length > 200) return 'service_role';
  return 'anon';
}

/**
 * Logs sécurisés au démarrage (sans exposer les clés complètes)
 */
export function logEnvStatus() {
  // Logs Supabase
  console.log('[ENV] SUPABASE_URL:', SUPABASE_CONFIG.url || '❌ absent');
  console.log('[ENV] SUPABASE_SERVICE_ROLE_KEY present:', !!SUPABASE_CONFIG.serviceRoleKey, 
    `(masked: ${maskKey(SUPABASE_CONFIG.serviceRoleKey)}, type: ${getSupabaseKeyType(SUPABASE_CONFIG.serviceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY')})`);
  
  // Vérifier aussi SUPABASE_ANON_KEY (pour l'auth)
  const anonKey = process.env.SUPABASE_ANON_KEY;
  console.log('[ENV] SUPABASE_ANON_KEY present:', !!anonKey,
    anonKey ? `(masked: ${maskKey(anonKey)}, type: ${getSupabaseKeyType(anonKey, 'SUPABASE_ANON_KEY')})` : '');
  
  console.log('[ENV] SUPABASE_JWT_JWKS_URL:', SUPABASE_CONFIG.jwtJwksUrl);
  
  console.log('[ENV] STRIPE_SECRET_KEY present:', !!STRIPE_CONFIG.secretKey,
    `(masked: ${maskKey(STRIPE_CONFIG.secretKey)})`);
  console.log('[ENV] STRIPE_WEBHOOK_SECRET present:', !!STRIPE_CONFIG.webhookSecret,
    `(masked: ${maskKey(STRIPE_CONFIG.webhookSecret)})`);
  console.log('[ENV] STRIPE_PRICE_ID present:', !!STRIPE_CONFIG.priceId);
  
  console.log('[ENV] APP_BASE_URL:', APP_CONFIG.baseUrl);
  console.log('[ENV] NODE_ENV:', APP_CONFIG.nodeEnv);
  console.log('[ENV] PORT:', APP_CONFIG.port);

  // N8N
  console.log('[ENV] N8N_WEBHOOK_URL present:', !!N8N_CONFIG.webhookUrl);
  console.log('[ENV] N8N_OCR_WEBHOOK_URL present:', !!N8N_CONFIG.ocrWebhookUrl);

  // AI
  console.log('[ENV] MISTRAL_API_KEY present:', !!AI_CONFIG.mistralApiKey,
    `(masked: ${maskKey(AI_CONFIG.mistralApiKey)})`);
  console.log('[ENV] MISTRAL_API_URL:', AI_CONFIG.mistralApiUrl);
  // OPENAI_API_URL conservée pour rétrocompatibilité, mais OpenAI n'est pas utilisé
  console.log('[ENV] OPENAI_API_URL:', AI_CONFIG.openaiApiUrl);

  // Public web
  console.log('[ENV] PUBLIC_WEB_BASE_URL:', PUBLIC_WEB_CONFIG.baseUrl);
}

// Valider toutes les variables au chargement du module
try {
  // Les requireEnv() ci-dessus vont throw si manquantes
  console.log('[ENV] ✅ Toutes les variables d\'environnement requises sont présentes');
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes('SUPABASE_URL') || msg.includes('SUPABASE_SERVICE_ROLE_KEY')) {
    throw new Error(
      'Démarrage impossible: SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis (Storage, auth). Vérifiez vos variables d\'environnement.'
    );
  }
  console.error('[ENV] ❌ Erreur de configuration:', msg);
  throw error;
}
