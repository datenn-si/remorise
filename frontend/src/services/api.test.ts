import { describe, expect, it } from 'vitest';

import { apiUrl } from './api';

describe('apiUrl', () => {
  it('targets the page origin so the Vite proxy carries API calls', () => {
    expect(apiUrl('/api/settings')).toBe('/api/settings');
    expect(apiUrl('/health')).toBe('/health');
  });
});
