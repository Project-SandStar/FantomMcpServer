const auth = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const init = await fetch('http://localhost:3848/admin/sidecars', { headers: { Authorization: auth } }).then(r => r.text());
const create = await fetch('http://localhost:3848/admin/sidecars', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'gpu-01', host: '127.0.0.1', port: 11434, protocol: 'http', enabled: true,
    capabilities: {
      embedding: { available: true, models: ['bge-small-en-v1.5', 'nomic-embed-text'], loaded: 'bge-small-en-v1.5', gpuPercent: 100 },
      llm: { available: true, models: ['llama-3.1-8b'] },
    },
  }),
}).then(r => r.text());
const id = JSON.parse(create).id;
const models = await fetch('http://localhost:3848/admin/sidecars/models?kind=embedding', { headers: { Authorization: auth } }).then(r => r.text());

const { default: WebSocket } = await import('ws');
const ws = new WebSocket('ws://localhost:3848/ws/sidecars');
const ack = await new Promise(resolve => {
  ws.on('open', () => ws.send(JSON.stringify({
    type: 'register', sidecarId: id,
    capabilities: { embedding: { available: true, models: ['bge-small-en-v1.5', 'qwen3-embedding:0.6b'], loaded: 'qwen3-embedding:0.6b', gpuPercent: 100 } },
  })));
  ws.on('message', d => { resolve(d.toString()); ws.close(); });
  ws.on('error', e => resolve('ERR ' + e.message));
  setTimeout(() => resolve('TIMEOUT'), 3000);
});
await new Promise(r => setTimeout(r, 200));
const after = await fetch('http://localhost:3848/admin/sidecars', { headers: { Authorization: auth } }).then(r => r.text());
await fetch(`http://localhost:3848/admin/sidecars/${id}`, { method: 'DELETE', headers: { Authorization: auth } });

console.log('initial:', init);
console.log('created id:', id);
console.log('models endpoint:', models);
console.log('ws ack:', ack);
console.log('after WS register:', after.slice(0, 1200));
