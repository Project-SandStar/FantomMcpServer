#!/usr/bin/env node
// UserPromptSubmit hook: one short hint naming the right Fantom MCP tool for
// the prompt. No network: reads the session cache written by session-start.
// Silent unless the directory is a registered project and the prompt matches.

import { emit, readJson, readStdinJson, sessionFile } from './_lib.mjs';

const input = (await readStdinJson()) || {};
const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
if (prompt.length < 12 || prompt.startsWith('/') || prompt.startsWith('!')) process.exit(0);

const sess = readJson(sessionFile(input.session_id || process.env.CLAUDE_SESSION_ID || 'unknown'));
const project = sess && sess.project;
if (!project) process.exit(0);

const RULES = [
  [/\b(who calls|callers?|call ?sites?|blast radius|impact of|what breaks|usages? of|references? to|used by)\b/i,
    'getCallers, then getCodeImpact (qualifiedName, projectId %id)'],
  [/\b(why did|what changed|recently changed|changed recently|history of|regress(ed|ion)|since (yesterday|last))\b/i,
    'whatChangedRecently (projectId %id) and getSymbolHistory'],
  [/\b(migrat\w*|3\.1\.\d+|3\.x|4\.0|deprecated|skyspark 4)\b/i,
    'searchVersionedApi, then the /fantom-mcp:wf-skyspark-4x-migration workflow'],
  [/\bxeto\b/i, 'searchFantomCode (projectId %id) and the /fantom-mcp:wf-xeto-spec-guide workflow'],
  [/\b(unit tests?|write (a )?tests?|test cases?|fant\b)/i, 'the /fantom-mcp:wf-unit-testing workflow'],
  [/\b(new pod|create (a )?pod|build\.fan|fanr)\b/i, 'the /fantom-mcp:wf-create-pod and /fantom-mcp:wf-use-fanr workflows'],
  [/\b(axon|defcomp|func rec)\b/i, 'searchFantomCode (projectId %id) or axonSearch / axonFunction'],
  [/\b(how (does|do|is|are|did)|explain|walk me through|architecture|flow of|where (is|does|are)|what happens when)\b/i,
    'askCodebase (query, projectId %id); it can take up to 120 s'],
  [/\b(find|search|look ?up|locate)\b.*\b(function|method|class|type|symbol|func|implementation)\b/i,
    'searchFantomCode or semanticCodeSearch (projectId %id)'],
];

for (const [re, hint] of RULES) {
  if (re.test(prompt)) {
    emit('UserPromptSubmit', `Fantom MCP hint (project "${project.name}", id ${project.id}): start with ${hint.replace(/%id/g, String(project.id))}. Tools are deferred: ToolSearch("fantom", 30) first.`);
    break;
  }
}
process.exit(0);
