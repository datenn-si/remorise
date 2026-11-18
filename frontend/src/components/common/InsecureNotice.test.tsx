import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { INSECURE_CONTEXT_NOTICE } from '../../lib/insecureContext';
import { InsecureNotice } from './InsecureNotice';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('InsecureNotice', () => {
  it('renders nothing on localhost', () => {
    const { container } = render(<InsecureNotice />);
    expect(container.textContent).toBe('');
  });

  it('shows the notice on a plain http remote address and reports dismissal', () => {
    vi.stubGlobal('location', new URL('http://192.168.1.5:5173/'));
    const onDismiss = vi.fn();
    const { getByRole, getByText } = render(<InsecureNotice onDismiss={onDismiss} />);
    expect(getByText(INSECURE_CONTEXT_NOTICE)).toBeTruthy();
    fireEvent.click(getByRole('button', { name: '通知を閉じる' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('shows the notice without a dismiss button when none is given', () => {
    vi.stubGlobal('location', new URL('http://100.119.18.117:8000/'));
    const { queryByRole, getByText } = render(<InsecureNotice />);
    expect(getByText(INSECURE_CONTEXT_NOTICE)).toBeTruthy();
    expect(queryByRole('button', { name: '通知を閉じる' })).toBeNull();
  });
});
