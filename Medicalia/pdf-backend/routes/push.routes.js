import { Router } from 'express';

const router = Router();

// POST /push/register-token
router.post('/register-token', (req, res) => {
  console.log('[PUSH] POST /push/register-token appelée (stub)');

  const userId = req.body?.userId;
  const token = req.body?.token;
  const tokenPrefix =
    token && typeof token === 'string' && token.length >= 8
      ? token.substring(0, 8) + '...'
      : 'invalid';

  console.log(`[PUSH] userId: ${userId || 'missing'}, token: ${tokenPrefix}`);

  res.status(200).json({ ok: true });
});

export default router;
