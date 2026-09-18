import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3848/sidecar');
const seen = [];
const out = await new Promise(resolve => {
  ws.on('open', () => {
    ws.send(JSON.stringify({ type:'register', agentUrl:'http://test:8098', hostname:'test-box' }));
    setTimeout(() => ws.send(JSON.stringify({
      type:'heartbeat',
      activeRequests: 0,
      statusData: {
        agentUrl:'http://test:8098', hostname:'test-box', mode:'searching',
        containers: { embedding: { name:'ss-embedding', status:'running', image:'ollama/ollama', model:'qwen3-embedding:0.6b', type:'ollama', config:{model:'qwen3-embedding:0.6b', port:11434, type:'ollama'}, loadedModels:[{name:'qwen3-embedding:0.6b', size:'600MB', gpuPercent:100, processor:'GPU'}] } },
      },
    })), 200);
  });
  ws.on('message', d => { seen.push(d.toString().slice(0, 200)); });
  setTimeout(() => { ws.close(); resolve({ openedOk: true, seen }); }, 1000);
  ws.on('error', e => resolve({ openedOk: false, error: e.message }));
});
console.log(JSON.stringify(out, null, 2));

const snap = await fetch('http://localhost:3848/api/admin/gpu/sidecars/snapshot').then(r=>r.json());
console.log('snapshots after test:', Object.keys(snap.snapshots ?? {}));
