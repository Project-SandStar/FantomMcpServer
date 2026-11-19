// Build the .trio corpus list (see CORPUS.md): walks the three roots, skips node_modules/.git/build/out
// and tree-sitter-*/test, dedupes by content hash.  node tree-sitter-trio/scripts/build-corpus.mjs <out-list>
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
const SKIP=new Set(['node_modules','.git','build','out']);
const roots=process.argv.slice(3).length?process.argv.slice(3):['haxall/haxall-4.0.4','Downloads/fantom-1.0.84','Code'].map(p=>os.homedir()+'/'+p);
const acc=[];
function walk(d){let es;try{es=fs.readdirSync(d,{withFileTypes:true})}catch{return}
 for(const e of es){const p=path.join(d,e.name);
  if(e.isDirectory()){ if(SKIP.has(e.name)) continue; if(/^tree-sitter-/.test(e.name)) { walkTS(p); continue;} walk(p);}
  else if(e.isFile()&&e.name.endsWith('.trio')) acc.push(p);}}
function walkTS(d){let es;try{es=fs.readdirSync(d,{withFileTypes:true})}catch{return}
 for(const e of es){const p=path.join(d,e.name); if(e.isDirectory()){ if(e.name==='test'||SKIP.has(e.name)) continue; walk(p);} else if(e.isFile()&&e.name.endsWith('.trio')) acc.push(p);}}
for(const r of roots) walk(r);
const seen=new Set(); const out=[]; let dup=0;
const pri=f=>roots.findIndex(r=>f.startsWith(r)); acc.sort((a,b)=>pri(a)-pri(b)||a.localeCompare(b)); for(const f of acc){ let b; try{b=fs.readFileSync(f)}catch{continue} const h=crypto.createHash('md5').update(b).digest('hex'); if(seen.has(h)){dup++;continue} seen.add(h); out.push(f);}
fs.writeFileSync(process.argv[2], out.join('\n')+'\n');
console.log(`found ${acc.length}, unique ${out.length}, dup ${dup}`);
const byRoot={}; for(const f of out){const r=roots.find(r=>f.startsWith(r)); byRoot[r]=(byRoot[r]||0)+1} console.log(byRoot);
