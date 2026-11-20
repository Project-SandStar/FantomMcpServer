/**
 * Decision model admin routes: pick Jev or Clef for the ask gates.
 *
 *   GET  /decision-model        current choice, models, key presence (never a key)
 *   POST /decision-model        save { provider?, clefModel? }
 *   POST /decision-model/test   { provider, clefModel? } → one tiny live decision
 *
 * Mounted on the admin router (Basic Auth). Both POSTs need the admin role.
 */
import { Router, type RequestHandler } from 'express';
import {
  describeDecisionModel,
  saveDecisionModelSettings,
  testDecisionModel,
  DecisionModelValidationError,
  type DecisionProvider,
} from '../embedding/providers/decisionModel.js';
import { scrubKey } from '../embedding/providers/clefClient.js';

export function createDecisionModelRouter(requireAdmin: RequestHandler): Router {
  const router = Router();

  router.get('/decision-model', (_req, res) => {
    try {
      res.json(describeDecisionModel());
    } catch (err) {
      res.status(500).json({ error: scrubKey(String((err as Error)?.message ?? err)) });
    }
  });

  router.post('/decision-model', requireAdmin, (req, res) => {
    try {
      saveDecisionModelSettings(req.body ?? {});
      res.json({ ok: true, ...describeDecisionModel() });
    } catch (err) {
      const status = err instanceof DecisionModelValidationError ? 400 : 500;
      res.status(status).json({ ok: false, error: scrubKey(String((err as Error)?.message ?? err)) });
    }
  });

  router.post('/decision-model/test', requireAdmin, async (req, res) => {
    const provider = req.body?.provider as DecisionProvider | undefined;
    if (provider !== 'jev' && provider !== 'clef') {
      res.status(400).json({ ok: false, error: 'provider must be jev or clef' });
      return;
    }
    const clefModel = typeof req.body?.clefModel === 'string' ? req.body.clefModel : undefined;
    // testDecisionModel never throws and scrubs the key itself.
    res.json(await testDecisionModel(provider, { clefModel }));
  });

  return router;
}
