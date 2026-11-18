import { useEffect, type RefObject } from 'react';

// While a text field is focused, the software keyboard occludes the
// bottom of the layout viewport and the browser pans the visual
// viewport up to reveal the field, dragging the whole page (header
// included) with it. This hook keeps the layout itself untouched —
// heights never change — and instead shifts the pieces: the header
// (and the banner stack under it) is translated by the pan offset so
// it stays glued to the visual top while content slides underneath
// and overflows above it, and the main region is translated up by
// the occluded height so the input rests on top of the keyboard.
// The sprite section is counter-translated by the same amount, so
// the character stays at its original position while only the
// message side slides up. The page is also told whether an editable
// field holds focus, so it can drop decorations that only make
// sense with the keyboard down (the glow at the character's feet:
// while typing, the slid-up message side covers the feet anyway).
//
// Not every browser only occludes: Firefox shrinks the layout
// viewport itself when the keyboard opens, so heights derived from
// dvh (the app shell, the sprite) would shrink along with it. The
// layout height at the moment a field takes focus is therefore
// frozen and published as --app-h for the shell to size itself by,
// and the occluded amount is measured against that frozen height —
// on browsers that never resize the layout, it is simply the live
// innerHeight and the numbers come out as before.
export function useViewportShift(
  headerRef: RefObject<HTMLElement | null>,
  bannerRef: RefObject<HTMLDivElement | null>,
  mainRef: RefObject<HTMLDivElement | null>,
  spriteRef: RefObject<HTMLElement | null>,
  onFocusChange?: (focused: boolean) => void,
) {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let focused = false;
    let frozenHeight: number | null = null;
    let unfreezeTimer: number | undefined;
    const apply = () => {
      const header = headerRef.current;
      const banner = bannerRef.current;
      const main = mainRef.current;
      const sprite = spriteRef.current;
      if (!focused) {
        if (header) header.style.transform = '';
        if (banner) banner.style.transform = '';
        if (main) main.style.transform = '';
        if (sprite) sprite.style.transform = '';
        return;
      }
      const pan = viewport.offsetTop;
      const occluded = Math.max(0, (frozenHeight ?? window.innerHeight) - viewport.height - pan);
      const pin = pan > 0 ? `translateY(${pan}px)` : '';
      if (header) header.style.transform = pin;
      if (banner) banner.style.transform = pin;
      if (main) main.style.transform = occluded > 0 ? `translateY(${-occluded}px)` : '';
      if (sprite) sprite.style.transform = occluded > 0 ? `translateY(${occluded}px)` : '';
    };
    const isEditable = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
    const onFocusIn = (event: FocusEvent) => {
      window.clearTimeout(unfreezeTimer);
      focused = isEditable(event.target);
      if (focused && frozenHeight === null) {
        frozenHeight = window.innerHeight;
        document.documentElement.style.setProperty('--app-h', `${frozenHeight}px`);
      }
      onFocusChange?.(focused);
      apply();
    };
    const onFocusOut = () => {
      focused = false;
      onFocusChange?.(false);
      apply();
      // Unfreeze a tick later: moving straight to another field
      // fires focusout first, and the frozen height must survive
      // that switch (by then the keyboard is already open, so a
      // fresh capture would freeze the shrunken height instead).
      unfreezeTimer = window.setTimeout(() => {
        frozenHeight = null;
        document.documentElement.style.removeProperty('--app-h');
      }, 0);
    };
    viewport.addEventListener('resize', apply);
    viewport.addEventListener('scroll', apply);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      window.clearTimeout(unfreezeTimer);
      document.documentElement.style.removeProperty('--app-h');
      viewport.removeEventListener('resize', apply);
      viewport.removeEventListener('scroll', apply);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [headerRef, bannerRef, mainRef, spriteRef, onFocusChange]);
}
