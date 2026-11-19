/**
 * Optional daily check (Settings > Installer sources > "Check daily"): once a
 * day, install the newest missing Haxall release and the newest missing
 * SkySpark installer, one job, one version each. Off by default.
 */

import { getActiveInstallerJob, startInstallerJob } from './jobs.js';
import { getInstallerSettings } from './settings.js';

const HOUR = 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let lastRun = 0;

export function startInstallerAutoCheck(): void {
  if (timer || process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return;
  timer = setInterval(() => { void tick(); }, HOUR);
  timer.unref();
}

async function tick(): Promise<void> {
  let settings;
  try { settings = getInstallerSettings(); } catch { return; }
  if (!settings.autoCheckDaily || Date.now() - lastRun < 23 * HOUR || getActiveInstallerJob()) return;
  lastRun = Date.now();
  try {
    startInstallerJob('auto-check', 'Daily installer check', async ctx => {
      const out: Record<string, unknown> = {};
      const { checkHaxall, buildHaxall } = await import('./haxall.js');
      try {
        const h = await checkHaxall();
        ctx.log(`Haxall missing: ${h.missing.join(', ') || 'none'}`);
        if (h.missing[0]) out.haxall = await buildHaxall(ctx, h.missing[0]);
      } catch (e) { ctx.note(`Haxall check failed: ${(e as Error).message}`); }
      if (settings.skyspark.source) {
        const { checkSkyspark, installSkyspark } = await import('./skyspark.js');
        try {
          const s = await checkSkyspark();
          ctx.log(`SkySpark missing: ${s.missing.join(', ') || 'none'}`);
          if (s.missing[0]) out.skyspark = await installSkyspark(ctx, s.missing[0]);
        } catch (e) { ctx.note(`SkySpark check failed: ${(e as Error).message}`); }
      }
      return out;
    });
  } catch { /* another job started meanwhile */ }
}
