import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AWAY_PATHS } from './routes';

describe('AWAY_PATHS', () => {
  it('covers every route App renders away from the chat page', () => {
    const appSource = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf-8');
    const routePaths = [...appSource.matchAll(/path="([^"]+)"/g)].map((match) => match[1]);
    expect(routePaths.length).toBeGreaterThan(0);
    for (const path of routePaths) {
      expect(AWAY_PATHS.has(path), path).toBe(true);
    }
  });
});
