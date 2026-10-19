/**
 * MCP schema of `reportChanges` (lazy-incremental-indexing.md 3.11.2). Kept
 * apart from focusTools.ts so src/index.ts can import it statically without
 * loading Prisma or the scheduler at module load.
 */

export const REPORT_CHANGES_TOOL = {
  name: 'reportChanges',
  description:
    'Tell the server which files you just wrote or edited, so the index follows your change within seconds. Cheap and asynchronous: adds the files to the focus set and queues one re-parse for the project (deduped); it does not wait for the parse or embed. Batch the files of one logical change into one call. Use reindexChangedFiles instead only when the next step needs the new code in search at once. Returns { projectId, queued, taskId, unknownFiles }; unknownFiles are paths outside every indexed project or not source files.',
  category: 'management',
  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Absolute or project-relative paths just written.',
      },
      projectId: { type: 'number', description: 'Optional. Resolved by longest path prefix when omitted.' },
      projectPath: { type: 'string', description: 'Optional alternative to projectId; base for relative paths.' },
      intent: { type: 'string', description: 'One line: why ("add retry to token refresh"). Kept with the change.' },
      sessionId: { type: 'string', description: 'Client session id; groups reports.' },
    },
    required: ['files'],
  },
};
