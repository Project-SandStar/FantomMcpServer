/**
 * Pod project names must be unique across versions. `auth` exists in every
 * Haxall; the bare pod name made the second version's create throw, and 57 of
 * 62 Haxall 4.0.6 pods were never indexed on the Docker server.
 */
import { jest } from '@jest/globals';

const { createTestDb } = await import('../indexing/__testSupport__/lazyIndexTestDb.js');
const testDb = await createTestDb();

jest.unstable_mockModule('../db/index.js', () => ({
  getPrismaClient: () => testDb.prisma,
}));

const { FantomDatabase } = await import('../fantom/database.js');
const db = new (FantomDatabase as any)() as InstanceType<typeof FantomDatabase>;

afterAll(async () => { await testDb.close(); });

describe('projectNameForPod', () => {
  let inst406: number;

  beforeAll(async () => {
    const i = await testDb.prisma.instance.create({
      data: { name: 'Haxall 4.0.6', path: '/mirror/haxall-4.0.6/home', type: 'haxall', version: '4.0.6' } as any,
    });
    inst406 = i.id;
    await testDb.prisma.fantomProject.create({
      data: { name: 'auth', path: '/mirror/haxall-4.0.4/src/core/auth' } as any,
    });
  });

  it('uses the bare pod name when it is free', async () => {
    expect(await db.projectNameForPod('hxComps', '/mirror/haxall-4.0.6/src/ext/hxComps', inst406)).toBe('hxComps');
  });

  it('qualifies with the instance name when another version holds the bare name', async () => {
    expect(await db.projectNameForPod('auth', '/mirror/haxall-4.0.6/src/core/auth', inst406)).toBe('Haxall 4.0.6:auth');
  });

  it('adds a path hash when the qualified name is taken too, or there is no instance', async () => {
    await testDb.prisma.fantomProject.create({
      data: { name: 'Haxall 4.0.6:auth', path: '/elsewhere/auth' } as any,
    });
    const a = await db.projectNameForPod('auth', '/mirror/haxall-4.0.6/src/core/auth', inst406);
    expect(a).toMatch(/^Haxall 4\.0\.6:auth#[0-9a-f]{6}$/);
    const b = await db.projectNameForPod('auth', '/some/other/auth', null);
    expect(b).toMatch(/^auth#[0-9a-f]{6}$/);
  });
});
