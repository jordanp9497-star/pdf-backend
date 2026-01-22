/**
 * EXEMPLE D'UTILISATION DES MIDDLEWARES D'AUTHENTIFICATION
 * 
 * Ce fichier montre comment utiliser authenticateSupabase et requireProfileRole
 * Vous pouvez supprimer ce fichier ou l'utiliser comme référence
 */

import express from 'express';
import { authenticateSupabase } from '../middlewares/auth.js';
import { requireProfileRole } from '../middlewares/profileRole.js';

const router = express.Router();

// ===== EXEMPLE 1: Route publique (pas d'authentification) =====
router.get('/public', (req, res) => {
  res.json({ 
    ok: true, 
    message: 'Route publique - accessible sans authentification' 
  });
});

// ===== EXEMPLE 2: Route protégée (authentification requise) =====
router.get('/protected', authenticateSupabase, (req, res) => {
  // req.user.id est disponible après authenticateSupabase
  res.json({ 
    ok: true, 
    message: 'Route protégée',
    userId: req.user.id 
  });
});

// ===== EXEMPLE 3: Route avec vérification de profil (profile_id dans params) =====
router.post('/profiles/:profileId/update',
  authenticateSupabase,  // 1. Vérifier l'authentification
  requireProfileRole('profileId', ['owner', 'admin']),  // 2. Vérifier les permissions
  (req, res) => {
    // req.user.id : ID de l'utilisateur authentifié
    // req.profileMembership.profileId : ID du profil
    // req.profileMembership.role : Rôle de l'utilisateur dans ce profil
    
    res.json({ 
      ok: true, 
      message: 'Profil mis à jour',
      userId: req.user.id,
      profileId: req.profileMembership.profileId,
      role: req.profileMembership.role
    });
  }
);

// ===== EXEMPLE 4: Route avec vérification de profil (profile_id dans body) =====
router.post('/action',
  authenticateSupabase,
  requireProfileRole('profile_id', ['owner']),  // Cherche dans req.body.profile_id
  (req, res) => {
    res.json({ 
      ok: true, 
      message: 'Action effectuée',
      profileId: req.profileMembership.profileId,
      role: req.profileMembership.role
    });
  }
);

// ===== EXEMPLE 5: Route avec plusieurs rôles autorisés =====
router.delete('/profiles/:profileId',
  authenticateSupabase,
  requireProfileRole('profileId', ['owner']),  // Seul le propriétaire peut supprimer
  (req, res) => {
    res.json({ 
      ok: true, 
      message: 'Profil supprimé',
      profileId: req.profileMembership.profileId
    });
  }
);

export default router;
