import { describe, expect, it } from 'vitest';

import { isPlainHttpRemote } from './insecureContext';

function locationOf(url: string): Location {
  return new URL(url) as unknown as Location;
}

describe('isPlainHttpRemote', () => {
  it('is true for plain http on a LAN or tailnet address', () => {
    expect(isPlainHttpRemote(locationOf('http://192.168.1.5:5173/'))).toBe(true);
    expect(isPlainHttpRemote(locationOf('http://100.119.18.117:8000/'))).toBe(true);
  });

  it('is false for https and for localhost in any form', () => {
    expect(isPlainHttpRemote(locationOf('https://192.168.1.5:5173/'))).toBe(false);
    expect(isPlainHttpRemote(locationOf('http://localhost:5173/'))).toBe(false);
    expect(isPlainHttpRemote(locationOf('http://dev.localhost:5173/'))).toBe(false);
    expect(isPlainHttpRemote(locationOf('http://127.0.0.1:5173/'))).toBe(false);
    expect(isPlainHttpRemote(locationOf('http://[::1]:5173/'))).toBe(false);
  });
});
