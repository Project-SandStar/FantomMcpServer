/**
 * Throw-away SQLite DB for lazy indexing tests: every migration under
 * prisma/migrations applied in order to a temp file, and a PrismaClient on it.
 * Never touches .cache/fantom.db.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { PrismaClient } from '@prisma/client';

export interface TestDb {
  prisma: PrismaClient;
  dir: string;
  close(): Promise<void>;
}

function statements(sql: string): string[] {
  return sql
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean);
}

export async function createTestDb(): Promise<TestDb> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazyidx-db-'));
  const file = path.join(dir, 'test.db');
  const prisma = new PrismaClient({ datasourceUrl: `file:${file}` });
  const migDir = path.resolve(process.cwd(), 'prisma', 'migrations');
  const migs = fs.readdirSync(migDir).filter(d => fs.existsSync(path.join(migDir, d, 'migration.sql'))).sort();
  for (const m of migs) {
    for (const s of statements(fs.readFileSync(path.join(migDir, m, 'migration.sql'), 'utf8'))) {
      await prisma.$executeRawUnsafe(s);
    }
  }
  return {
    prisma, dir,
    async close() {
      await prisma.$disconnect();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function addProject(prisma: PrismaClient, name: string, projectPath: string, language = 'typescript'): Promise<number> {
  const p = await prisma.fantomProject.create({ data: { name, path: projectPath, language, parserType: 'tree-sitter-wasm' } as any });
  return p.id;
}

/** git in a temp repo with a fixed identity; returns stdout. */
export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q');
  return fs.realpathSync(dir);
}

export function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
