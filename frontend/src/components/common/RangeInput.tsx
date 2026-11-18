import {
  useRef,
  type ChangeEvent,
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from 'react';

// A range input that does not let a stray touch move the value.
// Natively, touching the track jumps the value to the touched point
// at pointer-down — before the browser has decided whether the
// gesture is a page scroll (with touch-action: pan-y the scroll then
// takes over and fires pointercancel, but the jumped value stays).
// For touch and pen pointers this wrapper therefore holds change
// events back until the gesture proves to be a horizontal drag, and
// restores the thumb when the gesture ends as a tap or a scroll.
// Mouse and keyboard input keep the native behavior (clicking the
// track to jump is a deliberate act there).
const DRAG_THRESHOLD_PX = 8;

type Gesture = { startX: number; startY: number; committed: boolean };

export function RangeInput({
  onChange,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  ref,
  ...props
}: ComponentProps<'input'> & { ref?: Ref<HTMLInputElement> }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);

  const setRefs = (node: HTMLInputElement | null) => {
    inputRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) (ref as { current: HTMLInputElement | null }).current = node;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLInputElement>) => {
    onPointerDown?.(event);
    if (event.pointerType === 'mouse') return;
    gestureRef.current = { startX: event.clientX, startY: event.clientY, committed: false };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLInputElement>) => {
    onPointerMove?.(event);
    const gesture = gestureRef.current;
    if (!gesture || gesture.committed) return;
    const dx = Math.abs(event.clientX - gesture.startX);
    const dy = Math.abs(event.clientY - gesture.startY);
    if (dx >= DRAG_THRESHOLD_PX && dx > dy) {
      // From here on the input events the drag produces pass
      // through; the one for this very move arrives right after the
      // pointermove, so the value lands on the pointer's position.
      gesture.committed = true;
    }
  };

  const endGesture = () => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (gesture && !gesture.committed && inputRef.current) {
      // A tap or a scroll takeover: put the thumb back where the
      // controlled value says it belongs.
      inputRef.current.value = String(props.value ?? '');
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLInputElement>) => {
    onPointerUp?.(event);
    endGesture();
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLInputElement>) => {
    onPointerCancel?.(event);
    endGesture();
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const gesture = gestureRef.current;
    if (gesture && !gesture.committed) return;
    onChange?.(event);
  };

  return (
    <input
      {...props}
      ref={setRefs}
      type="range"
      onChange={handleChange}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    />
  );
}
