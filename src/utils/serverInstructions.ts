/**
 * MCP `instructions` sent in the initialize result. Every MCP client (Claude
 * Code, Codex, Cursor, ...) shows these to the model at connect time, so this
 * is the one place that reaches agents without the Claude Code plugin.
 * Keep it short: clients may cap or truncate it.
 */
export const SERVER_INSTRUCTIONS = [
  'Fantom MCP indexes registered code projects (Fantom, Axon, Haxall, SkySpark, Xeto, and TypeScript/JS/Vue/Python app code): symbols, a call graph, vectors, change history, docs.',
  'Before Grep/rg/find in a registered project, call one of these first: askCodebase (how does X work, where is Y; projectId), searchFantomCode or semanticCodeSearch (find code), getCallers + getCodeImpact (before changing a shared symbol). Use grep afterwards for exact strings.',
  'Do not skip the index because a startup summary looks small or old: call getIndexHealth (projectId) to see real coverage. Edits are re-indexed in the background.',
  'listFantomProjects maps a directory to its projectId. When you hand code search to a subagent, tell it the projectId and to use these tools before grep.',
].join('\n');
