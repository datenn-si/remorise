import type { Scheme } from './preferences';

// The browser chrome color (the theme-color meta tag) follows the
// UI theme's background color: the --color-canvas custom property
// that index.css derives from the reader's hue and scheme and that
// the body and the chat header paint themselves with. The value is
// read back from the computed style so the chrome always matches
// what is actually on screen, even if the CSS values change. The
// meta tag needs a plain sRGB hex, so the OKLCH value is converted
// here. When the computed value cannot be read (before the
// stylesheet applies, or in tests), the constants below — a mirror
// of the index.css values — are the fallback. The splash screen
// cannot do any of this at runtime: it uses the manifest's static
// colors, which are set to the default hue's dark background.
const DARK_CANVAS = { lightness: 0.178, chroma: 0.012 };
const LIGHT_CANVAS = { lightness: 0.97, chroma: 0.01 };

export function resolveScheme(scheme: Scheme, devicePrefersLight: boolean): 'light' | 'dark' {
  if (scheme === 'device') return devicePrefersLight ? 'light' : 'dark';
  return scheme;
}

export function themeColorHex(hue: number, scheme: 'light' | 'dark'): string {
  const base = scheme === 'light' ? LIGHT_CANVAS : DARK_CANVAS;
  return oklchToHex(base.lightness, base.chroma, hue);
}

// Parse a CSS color as serialized for --color-canvas (an oklch()
// triplet, or rgb() where a browser resolves it that way) into an
// sRGB hex string. Returns null for anything unrecognized.
export function cssColorToHex(value: string): string | null {
  const oklch = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value);
  if (oklch) return oklchToHex(Number(oklch[1]), Number(oklch[2]), Number(oklch[3]));
  const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(value);
  if (rgb) {
    return `#${[rgb[1], rgb[2], rgb[3]]
      .map((channel) => Number(channel).toString(16).padStart(2, '0'))
      .join('')}`;
  }
  return null;
}

export function uiBackgroundHex(): string | null {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return null;
  }
  try {
    const value = window
      .getComputedStyle(document.documentElement)
      .getPropertyValue('--color-canvas')
      .trim();
    return value ? cssColorToHex(value) : null;
  } catch {
    return null;
  }
}

export function applyThemeColor(hue: number, scheme: Scheme): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return;
  const fromCss = uiBackgroundHex();
  if (fromCss) {
    meta.content = fromCss;
    return;
  }
  const devicePrefersLight =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches;
  meta.content = themeColorHex(hue, resolveScheme(scheme, devicePrefersLight));
}

function oklchToHex(lightness: number, chroma: number, hueDegrees: number): string {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const cube = (value: number) => value * value * value;
  const l = cube(lightness + 0.3963377774 * a + 0.2158037573 * b);
  const m = cube(lightness - 0.1055613458 * a - 0.0638541728 * b);
  const s = cube(lightness - 0.0894841775 * a - 1.291485548 * b);
  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${channels
    .map((channel) =>
      Math.round(gamma(channel) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

function gamma(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}
