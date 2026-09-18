/**
 * Which table did the coverage number come from?
 *
 * THE INCIDENT THIS EXISTS FOR (2026-09-15). An operator reported:
 *
 *   "Vector Coverage 70.0% · 148,304/211,975 nodes embedded — was 100% before
 *    restarting. It should not have lowered back to 70%."
 *
 * Nothing was lost. `/admin/vectors/stats` counts the ACTIVE code slot, except
 * while `isShadowReembedActive()`, when it counts the SHADOW slot instead so a
 * rebuild in progress shows real progress. `shadowReembedActive` is an
 * in-process flag, so a restart clears it — and the very same endpoint then
 * answers the same question from a different table. Measured at the time of the
 * report: `code_vectors` (active) held 149,914 rows and `code_vectors_b`
 * (un-promoted shadow) held 225,008. Both were on disk simultaneously. The
 * percentage moved because the denominator stayed at 211,975 while the
 * NUMERATOR changed table underneath the operator.
 *
 * The defect is therefore in the reporting, not in the write path: a number
 * that silently changes its source is indistinguishable from data loss. This
 * module makes the source explicit and carries it in the payload, so the UI can
 * name the table the figure was counted from and show the other slot's rows
 * beside it.
 *
 * It is deliberately pure — no LanceDB, no Prisma — so the invariant can be
 * tested without a database.
 */

export type CoverageSlot = 'active' | 'shadow';

export interface CoverageSourceInput {
  /** `isShadowReembedActive()` — is a full re-embed building into the shadow? */
  building: boolean;
  /** `getActiveCodeTableName()`. */
  activeTable: string;
  /** `getInactiveCodeTableName()`. */
  inactiveTable: string;
  /** Rows in the ACTIVE slot (what semantic search serves). */
  activeRows: number;
  /**
   * Rows in the INACTIVE slot: the shadow being built, or the un-promoted
   * shadow a stopped/interrupted rebuild banked. 0 when that slot is empty or
   * absent.
   */
  shadowRows: number;
}

export interface CoverageSourceReport {
  /** Which slot the headline and per-project vector counts were counted from. */
  countedFrom: CoverageSlot;
  /** The name of that table. Render it — a figure whose table is unnamed is
   *  the whole bug. */
  countedTable: string;
  /** The slot semantic search serves, always. */
  activeTable: string;
  /** Rows in the active slot. */
  activeRows: number;
  /** Rows in the inactive slot, built or banked. */
  shadowRows: number;
  /**
   * Code vectors on disk across BOTH slots. This is the number that settles a
   * "coverage fell" report: if it has not dropped, no vector was lost and the
   * displayed figure merely changed table.
   */
  rowsOnDisk: number;
}

/**
 * Name the slot the coverage figure is counted from.
 *
 * `slotToCount` is what `VectorStore.countByProject()` should be passed:
 * `null` means "the active slot" (its default).
 */
export function resolveCoverageSource(
  input: CoverageSourceInput,
): CoverageSourceReport & { slotToCount: string | null } {
  const countedFrom: CoverageSlot = input.building ? 'shadow' : 'active';
  const countedTable = input.building ? input.inactiveTable : input.activeTable;
  return {
    countedFrom,
    countedTable,
    activeTable: input.activeTable,
    activeRows: input.activeRows,
    shadowRows: input.shadowRows,
    rowsOnDisk: input.activeRows + input.shadowRows,
    slotToCount: input.building ? input.inactiveTable : null,
  };
}

/**
 * Did coverage fall because rows were lost, or because the figure changed
 * table? Answers the operator's question directly from two reports taken
 * across a restart.
 *
 * `'row-loss'` is the only verdict that justifies touching the write path.
 */
export function explainCoverageChange(
  before: Pick<CoverageSourceReport, 'countedFrom' | 'countedTable' | 'rowsOnDisk'>,
  after: Pick<CoverageSourceReport, 'countedFrom' | 'countedTable' | 'rowsOnDisk'>,
): 'row-loss' | 'slot-flip' | 'unchanged' {
  if (after.rowsOnDisk < before.rowsOnDisk) return 'row-loss';
  if (after.countedTable !== before.countedTable) return 'slot-flip';
  return 'unchanged';
}
