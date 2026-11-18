import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { buttonClass } from '../../lib/ui';
import { ReloadButton } from './ErrorBoundary';

type Props = { children: ReactNode };
type State = { failed: boolean };

/**
 * Boundary for the lazily loaded sub-screens. A chunk that cannot be
 * fetched (the server is unreachable, so the on-demand page code
 * never arrives) must not take the whole app down with it: the chat
 * stays mounted behind this boundary, so the failure is shown as a
 * page-level notice with a way back. The caller keys this boundary
 * by the route, so navigating anywhere remounts it with a clean
 * state and the target page is tried again.
 */
export class RouteErrorBoundary extends Component<Props, State> {
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
          <h1 className="text-xl">ページを表示できません</h1>
          <p className="mt-2 text-muted">
            読み込みに失敗しました。サーバーに接続できないときに起こります。
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <Link to="/" className={buttonClass}>
              会話へ戻る
            </Link>
            <ReloadButton />
          </div>
        </div>
      </div>
    );
  }
}
