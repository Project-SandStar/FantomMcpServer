// Long-lived re-embed kickoff. Uses a keep-alive Agent + raw http.request
// so node's fetch / undici socket-idle defaults can't drop us mid-job.
import http from 'node:http';
import * as fs from 'node:fs/promises';

const auth = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const startedAt = new Date().toISOString();

await fs.writeFile('/tmp/reembed-status.json', JSON.stringify({ phase: 'started', startedAt }));

const body = JSON.stringify({ batchSize: 50 });
const req = http.request({
  hostname: '127.0.0.1',
  port: 3848,
  path: '/admin/vectors/re-embed/0',
  method: 'POST',
  headers: {
    'Authorization': auth,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Connection': 'keep-alive',
  },
  // No socket timeout: long jobs can run for hours.
  agent: new http.Agent({ keepAlive: true, keepAliveMsecs: 30_000, scheduling: 'fifo' }),
}, async (res) => {
  let buf = '';
  res.setEncoding('utf-8');
  res.on('data', chunk => { buf += chunk; });
  res.on('end', async () => {
    await fs.writeFile('/tmp/reembed-result.json', buf);
    await fs.writeFile('/tmp/reembed-status.json', JSON.stringify({
      phase: res.statusCode === 200 ? 'done' : 'error',
      httpStatus: res.statusCode,
      finishedAt: new Date().toISOString(),
      durationSec: (Date.now() - Date.parse(startedAt)) / 1000,
    }));
  });
});
req.on('error', async (err) => {
  await fs.writeFile('/tmp/reembed-status.json', JSON.stringify({
    phase: 'error',
    error: String(err?.message ?? err),
    finishedAt: new Date().toISOString(),
    durationSec: (Date.now() - Date.parse(startedAt)) / 1000,
  }));
});
req.setNoDelay(true);
req.write(body);
req.end();
