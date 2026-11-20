#!/usr/bin/env node
/**
 * Embed the benchmark queries with Fantom's own OpenRouter client (same model,
 * pin and query instruction as live search). Writes <dir>/queries.json.
 * Run inside the Fantom container: node scripts/bench-embed-queries.mjs [--dir d]
 * The key is read by the client from the secrets store and never printed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const i = process.argv.indexOf('--dir');
const DIR = i > 0 ? process.argv[i + 1] : path.join(process.cwd(), '.cache', 'bench');
const build = path.join(process.cwd(), 'build');

const QUERIES = [
  'parse a zinc grid', 'parse config file', 'read a value from a point', 'write a history record',
  'open an http connection', 'authenticate a user with scram', 'convert a number to a string with units',
  'format a date time in a time zone', 'serialize a dict to json', 'read a csv file', 'schedule a background job',
  'handle websocket messages', 'send an email', 'compute the hash of a file', 'base64 encode bytes',
  'list files in a directory', 'watch a point for changes', 'subscribe to point updates',
  'history rollup by hour', 'evaluate an axon expression', 'define a new function in axon',
  'connector polling loop', 'modbus register read', 'bacnet discover devices', 'sql query to database',
  'log an error with stack trace', 'retry on timeout', 'actor message handling', 'parse a uri query string',
  'escape html', 'sort a list by a field', 'merge two dicts', 'validate input parameters',
  'load a pod resource file', 'convert fahrenheit to celsius', 'average of a list of numbers',
  'build a grid with columns and rows', 'filter records by tag', 'rule for a hot room',
  'equipment and point relationships', 'read site weather data', 'start the web server on a port',
  'handle file upload', 'cache results in memory', 'lock to avoid concurrent writes', 'generate a uuid',
  'compare two version numbers', 'hash a password', 'close a socket', 'test setup and teardown',
];

const { embed } = await import(path.join(build, 'openrouter', 'client.js'));
const { cloudRoleModel } = await import(path.join(build, 'openrouter', 'roles.js'));
const { applyQueryInstruction } = await import(path.join(build, 'embedding', 'queryInstruction.js'));

const m = cloudRoleModel('code-embedding');
if (!m || !m.pin) { console.error('no code-embedding model/pin configured'); process.exit(1); }
const texts = QUERIES.map((q) => applyQueryInstruction(q, m.model, 'code'));
const r = await embed(texts, { role: 'code-embedding', model: m.model, pin: m.pin, timeoutMs: 120_000 });
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, 'queries.json'), JSON.stringify(QUERIES.map((q, k) => ({ q, v: Array.from(r.vectors[k]) }))));
console.log(JSON.stringify({ queries: QUERIES.length, model: m.model, dims: r.dims, ms: r.ms }));
process.exit(0);
