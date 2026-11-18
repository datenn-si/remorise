import { cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RangeInput } from './RangeInput';

function Harness({ onValue }: { onValue: (value: number) => void }) {
  const [value, setValue] = useState(50);
  return (
    <RangeInput
      min={0}
      max={100}
      value={value}
      aria-label="テストスライダー"
      onChange={(event) => {
        const next = Number(event.target.value);
        setValue(next);
        onValue(next);
      }}
    />
  );
}

afterEach(() => cleanup());

describe('RangeInput', () => {
  it('ignores a touch tap on the track (the native jump is held back)', () => {
    const onValue = vi.fn();
    const { getByLabelText } = render(<Harness onValue={onValue} />);
    const input = getByLabelText('テストスライダー') as HTMLInputElement;
    fireEvent.pointerDown(input, { pointerType: 'touch', clientX: 90, clientY: 0 });
    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.pointerUp(input, { pointerType: 'touch', clientX: 90, clientY: 0 });
    expect(onValue).not.toHaveBeenCalled();
    expect(input.value).toBe('50');
  });

  it('ignores a touch that turns into a page scroll (pointercancel)', () => {
    const onValue = vi.fn();
    const { getByLabelText } = render(<Harness onValue={onValue} />);
    const input = getByLabelText('テストスライダー') as HTMLInputElement;
    fireEvent.pointerDown(input, { pointerType: 'touch', clientX: 80, clientY: 0 });
    fireEvent.change(input, { target: { value: '80' } });
    fireEvent.pointerCancel(input, { pointerType: 'touch' });
    expect(onValue).not.toHaveBeenCalled();
    expect(input.value).toBe('50');
  });

  it('applies the value once a touch becomes a horizontal drag', () => {
    const onValue = vi.fn();
    const { getByLabelText } = render(<Harness onValue={onValue} />);
    const input = getByLabelText('テストスライダー') as HTMLInputElement;
    fireEvent.pointerDown(input, { pointerType: 'touch', clientX: 50, clientY: 0 });
    fireEvent.change(input, { target: { value: '70' } });
    expect(onValue).not.toHaveBeenCalled();
    fireEvent.pointerMove(input, { pointerType: 'touch', clientX: 75, clientY: 2 });
    fireEvent.change(input, { target: { value: '85' } });
    expect(onValue).toHaveBeenCalledWith(85);
    fireEvent.pointerUp(input, { pointerType: 'touch', clientX: 85, clientY: 2 });
    expect(input.value).toBe('85');
  });

  it('keeps native behavior for the mouse', () => {
    const onValue = vi.fn();
    const { getByLabelText } = render(<Harness onValue={onValue} />);
    const input = getByLabelText('テストスライダー') as HTMLInputElement;
    fireEvent.pointerDown(input, { pointerType: 'mouse', clientX: 90, clientY: 0 });
    fireEvent.change(input, { target: { value: '90' } });
    expect(onValue).toHaveBeenCalledWith(90);
  });
});
