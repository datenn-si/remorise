import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { primaryButtonClass } from '../../lib/ui';

/**
 * Full reload with visible feedback: the tap flips the button to a
 * disabled "reloading" label first, so the user can see the press
 * landed even when the reload itself is slow (or the browser takes
 * a moment to tear the page down). The short delay lets that state
 * paint before navigation starts.
 */
export function ReloadButton() {
  const [reloading, setReloading] = useState(false);
  return (
    <button
      type="button"
      className={primaryButtonClass}
      disabled={reloading}
      onClick={() => {
        setReloading(true);
        setTimeout(() => window.location.reload(), 150);
      }}
    >
      {reloading ? '再読み込み中…' : '再読み込み'}
    </button>
  );
}

type Props = { children: ReactNode };
type State = { failed: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="grid h-dvh place-items-center px-6">
        <div className="max-w-md text-center">
          <h1 className="text-xl">画面を表示できません</h1>
          <p className="mt-2 text-muted">再読み込みして、もう一度開いてください。</p>
          <div className="mt-4">
            <ReloadButton />
          </div>
        </div>
      </div>
    );
  }
}
