import { useEffect, useId, useRef, type ReactNode } from 'react';

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="w-[min(100%,36rem)] rounded-2xl border border-line bg-panel text-ink shadow-2xl"
      onClose={onClose}
      onMouseDown={(event) => {
        const dialog = ref.current;
        if (!dialog) return;
        const rect = dialog.getBoundingClientRect();
        const inside =
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom;
        if (!inside) onClose();
      }}
    >
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <h2 id={titleId} className="text-lg">
          {title}
        </h2>
        <button
          type="button"
          className="rounded-full p-2.5 text-muted hover:text-ink cursor-pointer"
          onClick={onClose}
          aria-label="閉じる"
        >
          <span className="icon-[mdi--close] text-lg" aria-hidden="true" />
        </button>
      </div>
      <div className="max-h-[70dvh] overflow-y-auto px-4 py-4">{children}</div>
    </dialog>
  );
}
