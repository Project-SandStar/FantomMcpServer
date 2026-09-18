/**
 * Regression test for "Vector Coverage was 100% before restarting, now 70%".
 *
 * The report read as data loss. It was not. `/admin/vectors/stats` counts the
 * ACTIVE code slot, except while `isShadowReembedActive()`, when it counts the
 * SHADOW slot so a rebuild in progress shows real progress. That flag lives in
 * process memory, so a restart clears it — and the same endpoint then answers
 * the same question from a different table, with the same denominator.
 *
 * Numbers measured on the live server while investigating:
 *
 *   code_vectors   (active, un-changed)        149,914 rows
 *   code_vectors_b (shadow, un-promoted)       225,008 rows  (324 projects)
 *   per-project graph nodes (denominator)      211,975
 *
 * 149,914 / 211,975 = 70.7%. The operator's 70.0% was 148,304 / 211,975, an
 * earlier reading of the SAME table — it has since grown, not shrunk. Both
 * tables were on disk at the same time, so nothing was lost.
 *
 * What this test pins: the payload must SAY which table it counted, and must
 * carry rows across both slots, so a flip can never again be mistaken for a
 * loss. If someone deletes `countedTable` or `rowsOnDisk`, or makes the slot
 * choice implicit again, these fail.
 */

import { resolveCoverageSource, explainCoverageChange } from '../embedding/coverageSource.js';

/** The live slot, as measured. */
const ACTIVE_ROWS = 149_914;
/** The un-promoted shadow a stopped rebuild banked, as measured. */
const SHADOW_ROWS = 225_008;
/** Per-project graph CodeNode total — the coverage denominator. */
const NODES = 211_975;

const SLOTS = { activeTable: 'code_vectors', inactiveTable: 'code_vectors_b' };

describe('the coverage figure always names the table it came from', () => {
  it('counts the shadow while a rebuild is building, and says so', () => {
    const r = resolveCoverageSource({
      building: true, ...SLOTS, activeRows: ACTIVE_ROWS, shadowRows: SHADOW_ROWS,
    });
    expect(r.countedFrom).toBe('shadow');
    expect(r.countedTable).toBe('code_vectors_b');
    // Search keeps serving the live slot no matter what the headline counts.
    expect(r.activeTable).toBe('code_vectors');
    expect(r.slotToCount).toBe('code_vectors_b');
  });

  it('counts the active slot when nothing is building, and says so', () => {
    const r = resolveCoverageSource({
      building: false, ...SLOTS, activeRows: ACTIVE_ROWS, shadowRows: SHADOW_ROWS,
    });
    expect(r.countedFrom).toBe('active');
    expect(r.countedTable).toBe('code_vectors');
    // null = "the store's default slot", which is the active one.
    expect(r.slotToCount).toBeNull();
  });

  it('reports rows across BOTH slots, not just the one it counted', () => {
    for (const building of [true, false]) {
      const r = resolveCoverageSource({
        building, ...SLOTS, activeRows: ACTIVE_ROWS, shadowRows: SHADOW_ROWS,
      });
      expect(r.activeRows).toBe(ACTIVE_ROWS);
      expect(r.shadowRows).toBe(SHADOW_ROWS);
      expect(r.rowsOnDisk).toBe(ACTIVE_ROWS + SHADOW_ROWS);
    }
  });
});

describe('the reported incident, replayed', () => {
  const before = resolveCoverageSource({
    building: true, ...SLOTS, activeRows: ACTIVE_ROWS, shadowRows: SHADOW_ROWS,
  });
  const after = resolveCoverageSource({
    building: false, ...SLOTS, activeRows: ACTIVE_ROWS, shadowRows: SHADOW_ROWS,
  });

  it('is a slot flip, not row loss', () => {
    expect(explainCoverageChange(before, after)).toBe('slot-flip');
  });

  it('moves the displayed coverage from ~100% to ~70% with nothing deleted', () => {
    // Shadow-sourced: 225,008 of 211,975 nodes — over 100%, which every bar in
    // the dashboard clamps to 100 (ProgressStrip / GlobalProgressPanel both
    // use Math.min(100, pct)). That clamp is exactly what the operator saw.
    const shownWhileBuilding = Math.min(100, (SHADOW_ROWS / NODES) * 100);
    const shownAfterRestart = (ACTIVE_ROWS / NODES) * 100;
    expect(shownWhileBuilding).toBe(100);
    expect(shownAfterRestart).toBeCloseTo(70.7, 1);
    // ...and the number that actually matters did not move.
    expect(after.rowsOnDisk).toBe(before.rowsOnDisk);
  });

  it('calls it row loss only when rows really left the disk', () => {
    const lost = resolveCoverageSource({
      building: false, ...SLOTS, activeRows: ACTIVE_ROWS, shadowRows: 0,
    });
    expect(explainCoverageChange(before, lost)).toBe('row-loss');
  });

  it('says nothing changed when the same table is counted twice', () => {
    expect(explainCoverageChange(after, after)).toBe('unchanged');
  });
});

describe('a promoted rebuild is not a flip either', () => {
  it('reports the promoted slot as active once the pointer moved', () => {
    // After promoteCodeTable('code_vectors_b') the pointer flips and the old
    // slot is dropped: the active table IS the shadow's rows.
    const promoted = resolveCoverageSource({
      building: false,
      activeTable: 'code_vectors_b',
      inactiveTable: 'code_vectors',
      activeRows: SHADOW_ROWS,
      shadowRows: 0,
    });
    expect(promoted.countedFrom).toBe('active');
    expect(promoted.countedTable).toBe('code_vectors_b');
    expect(promoted.rowsOnDisk).toBe(SHADOW_ROWS);
  });
});
