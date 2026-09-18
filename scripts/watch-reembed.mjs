// Tail the async re-embed job and print one line per state change.
// Exits when the job leaves running/queued.
import * as fs from 'node:fs/promises';

const auth = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const jobId = (await fs.readFile('/tmp/reembed-job-id.txt', 'utf-8')).trim();

let prev = '';
while (true) {
  const j = await fetch(`http://localhost:3848/admin/vectors/re-embed/jobs/${jobId}`, {
    headers: { Authorization: auth },
  }).then(r => r.json()).catch(() => null);
  if (!j) {
    await new Promise(r => setTimeout(r, 30000));
    continue;
  }
  const cur = `status=${j.status} proj=${j.doneProjects}/${j.totalProjects} gen=${j.generated} dropped=${j.deleted} errs=${j.errors.length} cur=#${j.currentProjectId ?? '-'}`;
  if (cur !== prev) {
    console.log(cur);
    prev = cur;
  }
  if (j.status !== 'running' && j.status !== 'queued') {
    console.log(`FINAL: ${cur}`);
    if (j.errors.length) {
      const sample = j.errors.slice(0, 3).map(e => `  proj#${e.projectId}: ${e.message}`);
      console.log('first errors:\n' + sample.join('\n'));
    }
    break;
  }
  await new Promise(r => setTimeout(r, 30000));
}
