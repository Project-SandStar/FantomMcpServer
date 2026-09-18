// Run with `npm test`, which sets NODE_OPTIONS=--experimental-vm-modules.
// Without that flag Jest has no ESM loader, `extensionsToTreatAsEsm` below is
// inert, and every suite that transitively reaches `src/config/index.ts` (which
// uses `import.meta.url`) dies at compile time — 12 of 18 suites, silently
// reported as "Test suite failed to run" while the remaining 6 pass green.
// A bare `npx jest` still does that; prefer `npm test`.
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        // ts-jest's own default (module: CommonJS) overrode tsconfig's ES2022
        // and made every suite that transitively reaches a file using
        // `import.meta` fail to compile — which is every suite, since
        // src/config/index.ts uses it. Pin the module system to match the ESM
        // the runtime actually uses.
        tsconfig: {
          module: 'ESNext',
          target: 'ES2022',
          moduleResolution: 'bundler',
        },
      },
    ],
  },
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  // Agent worktrees live under .claude/worktrees/<id>/ and carry a full copy
  // of the tree; without these, jest runs every suite twice (once per copy)
  // and the duplicates collide on module identity.
  testPathIgnorePatterns: ['/node_modules/', '/\\.claude/', '/build/'],
  modulePathIgnorePatterns: ['<rootDir>/\\.claude/', '<rootDir>/build/'],
  watchPathIgnorePatterns: ['<rootDir>/\\.claude/'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
};
