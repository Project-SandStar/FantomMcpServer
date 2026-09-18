const auth = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const r = await fetch('http://localhost:3848/admin/sidecars', { headers: { Authorization: auth } }).then(r => r.json());
console.log(JSON.stringify(r, null, 2));
