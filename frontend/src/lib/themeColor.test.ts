import { describe, expect, it } from 'vitest';

import { applyThemeColor, cssColorToHex, resolveScheme, themeColorHex } from './themeColor';

describe('themeColorHex', () => {
  it('matches the canvas colors at the default hue', () => {
    expect(themeColorHex(314, 'dark')).toBe('#131015');
    expect(themeColorHex(314, 'light')).toBe('#f8f3fa');
  });

  it('moves with the hue', () => {
    expect(themeColorHex(0, 'dark')).not.toBe(themeColorHex(180, 'dark'));
    expect(themeColorHex(0, 'light')).not.toBe(themeColorHex(180, 'light'));
  });
});

describe('cssColorToHex', () => {
  it('converts the oklch values index.css uses', () => {
    expect(cssColorToHex('oklch(0.178 0.012 314)')).toBe('#131015');
    expect(cssColorToHex('oklch(0.97 0.01 314)')).toBe('#f8f3fa');
  });

  it('converts rgb serializations and rejects anything else', () => {
    expect(cssColorToHex('rgb(19, 16, 21)')).toBe('#131015');
    expect(cssColorToHex('')).toBeNull();
    expect(cssColorToHex('transparent')).toBeNull();
  });
});

describe('applyThemeColor', () => {
  it('prefers the UI background color from the CSS variable', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
    document.documentElement.style.setProperty('--color-canvas', 'oklch(0.5 0.1 200)');
    try {
      applyThemeColor(314, 'dark');
      expect(meta.content).toBe(cssColorToHex('oklch(0.5 0.1 200)'));
      expect(meta.content).not.toBe(themeColorHex(314, 'dark'));
    } finally {
      document.documentElement.style.removeProperty('--color-canvas');
      meta.remove();
    }
  });
});

describe('resolveScheme', () => {
  it('follows the device only in device mode', () => {
    expect(resolveScheme('device', true)).toBe('light');
    expect(resolveScheme('device', false)).toBe('dark');
    expect(resolveScheme('light', false)).toBe('light');
    expect(resolveScheme('dark', true)).toBe('dark');
  });
});
