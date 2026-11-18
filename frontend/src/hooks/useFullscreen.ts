import { useCallback, useEffect, useState } from 'react';

/**
 * Whether the Fullscreen API can be used from this origin at all.
 * The API requires a secure context (https or localhost): on a plain
 * http origin such as the tailnet address the browser reports
 * `fullscreenEnabled === false` and element fullscreen is missing,
 * so callers hide the control entirely there instead of showing a
 * button that can only fail.
 */
export function fullscreenSupported(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.fullscreenEnabled === true &&
    typeof document.documentElement?.requestFullscreen === 'function'
  );
}

export function useFullscreen(): {
  supported: boolean;
  fullscreen: boolean;
  toggle: () => void;
} {
  const [supported] = useState(fullscreenSupported);
  const [fullscreen, setFullscreen] = useState<boolean>(
    () => typeof document !== 'undefined' && Boolean(document.fullscreenElement),
  );

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void document.documentElement.requestFullscreen().catch(() => undefined);
    }
  }, []);

  return { supported, fullscreen, toggle };
}
