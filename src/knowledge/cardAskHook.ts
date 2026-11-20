/**
 * The one hook answerCodeQuestion calls: when "use cards to answer asks" is
 * on, try the card fast path and shape a hit as an ask result. Null = run the
 * normal ask path.
 */
import type { AnswerCodeQuestionOptions, AnswerCodeQuestionResult } from '../embedding/answerSynthesis.js';
import { getCardSettings } from './cardSettings.js';

export async function tryCardAnswer(query: string, opts: AnswerCodeQuestionOptions): Promise<AnswerCodeQuestionResult | null> {
  const s = getCardSettings();
  if (!s.useForAsks) return null;
  let projectIds: number[] | undefined;
  if (typeof opts.projectId === 'number') projectIds = [opts.projectId];
  else if (opts.versionGroup) {
    const { scopeForRequest } = await import('../projects/versionGroup.js');
    projectIds = (await scopeForRequest({ versionGroup: opts.versionGroup as any })).projectIds;
  }
  const { answerFromCards } = await import('./cardAnswer.js');
  const r = await answerFromCards(query, { projectIds, settings: s });
  if (!r.answered || !r.answer) return null;
  return {
    answer: r.answer,
    citations: (r.citations ?? []).map(c => ({ ...c, via: 'seed' as const })),
    usedResults: r.cards?.length ?? 0,
    provider: 'knowledge-cards',
    model: r.model ?? s.answerModel,
    historyIncluded: false,
    complexity: null,
    rlm: { used: false },
    stages: [],
    settingsLine: `knowledge cards (best match ${r.bestScore?.toFixed(2)}, built ${r.builtAt}) in ${r.timings.totalMs} ms`,
  } as unknown as AnswerCodeQuestionResult;
}
