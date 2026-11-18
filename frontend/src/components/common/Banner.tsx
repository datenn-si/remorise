import { buttonClass } from '../../lib/ui';

export function Banner({
  tone,
  text,
  onDismiss,
  onRetry,
}: {
  tone: 'error' | 'info';
  text: string;
  onDismiss?: () => void;
  onRetry?: () => void;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2 border-b px-4 py-2 text-sm ${
        tone === 'error'
          ? 'border-danger/40 bg-danger-panel text-danger'
          : 'border-line bg-panel-2 text-ink'
      }`}
    >
      <span className="icon-[mdi--alert-circle] mt-0.5 shrink-0 text-base" aria-hidden="true" />
      <p className="min-w-0 flex-1">{text}</p>
      {onRetry && (
        <button type="button" className={buttonClass} onClick={onRetry}>
          再試行
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          className="rounded-full p-2"
          onClick={onDismiss}
          aria-label="通知を閉じる"
        >
          <span className="icon-[mdi--close] text-base" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
