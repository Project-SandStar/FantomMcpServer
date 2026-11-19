/**
 * fileRouter: one table decides the parser family and node language per
 * file. Fantom-family files route the same way under every project language.
 */

import { routeFile, isBuildFile } from '../fantom-code/fileRouter.js';

describe('routeFile', () => {
  it('sends Fantom-family files to their own parsers', () => {
    expect(routeFile('/p/pod/vizExt/fan/VizExt.fan')).toMatchObject({ kind: 'fan', language: 'fantom' });
    expect(routeFile('/p/pod/vizExt/lib/funcs.trio')).toMatchObject({ kind: 'trio', language: 'axon' });
    expect(routeFile('/p/pod/vizExt/lib/calc.axon')).toMatchObject({ kind: 'axon', language: 'axon' });
  });

  it('build.fan is metadata, not a source file', () => {
    expect(routeFile('/p/pod/vizExt/build.fan').kind).toBe('skip');
    expect(isBuildFile('/p/build.fan')).toBe(true);
    expect(isBuildFile('/p/Build.fan')).toBe(false);
    expect(isBuildFile('/p/buildx.fan')).toBe(false);
  });

  it('vue and markdown have their own families', () => {
    expect(routeFile('/p/src/App.vue')).toMatchObject({ kind: 'vue', language: 'vue' });
    expect(routeFile('/p/README.md')).toMatchObject({ kind: 'markdown', language: 'markdown' });
    expect(routeFile('/p/docs/x.MDX').kind).toBe('markdown');
  });

  it('other source files go to the primary parser with their registry language', () => {
    expect(routeFile('/p/src/index.ts')).toMatchObject({ kind: 'primary', language: 'typescript' });
    expect(routeFile('/p/src/a.py')).toMatchObject({ kind: 'primary', language: 'python' });
    expect(routeFile('/p/src/a.PHP').language).toBe('php');
  });

  it('unknown extensions are primary/unknown', () => {
    expect(routeFile('/p/src/a.weird')).toMatchObject({ kind: 'primary', language: 'unknown' });
    expect(routeFile('/p/Makefile')).toMatchObject({ kind: 'primary', ext: '' });
  });
});
