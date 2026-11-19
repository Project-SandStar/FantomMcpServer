// Compare record and tag counts per file: wasm parse vs haystack::TrioReader.
//   node tree-sitter-trio/scripts/compare-reader.mjs <wasm> <reader-counts.tsv>
// The tsv comes from scripts/TrioCount.fan run with a Fantom runtime that has the haystack pod.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(repo, 'package.json'));
const [wasmPath, tsv] = process.argv.slice(2);
const TS = require(path.join(repo, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.cjs'));
await TS.Parser.init(); const lang = await TS.Language.load(path.resolve(wasmPath));
const parser = new TS.Parser(); parser.setLanguage(lang);
let same=0, diff=0, skipped=0; const diffs=[];
for (const line of fs.readFileSync(tsv,'utf8').split('\n')) {
  if (!line) continue; const [f, recs, tags] = line.split('\t');
  if (recs === 'ERR') { skipped++; continue; }
  const tree = parser.parse(fs.readFileSync(f,'utf8'));
  let r=0,t=0; const st=[tree.rootNode];
  while (st.length){const n=st.pop(); if(n.type==='record')r++; else if(n.type==='tag'||n.type==='block_tag')t++; for(let i=n.childCount-1;i>=0;i--)st.push(n.child(i));}
  tree.delete();
  if (r===+recs && t===+tags) same++; else { diff++; diffs.push(`${f.replace(os.homedir(),'~')}  reader ${recs}r/${tags}t  grammar ${r}r/${t}t`); }
}
console.log(`compared ${same+diff}: same ${same}, different ${diff}, reader-rejected ${skipped}`);
for (const d of diffs.slice(0, 40)) console.log('  '+d);
