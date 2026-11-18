import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { buttonClass, fieldClass, primaryButtonClass } from '../../lib/ui';
import { CharacterMarkdown } from './CharacterMarkdown';

export function MessageInput({
  value,
  locked,
  offline = false,
  onChange,
  onSend,
}: {
  value: string;
  locked: boolean;
  offline?: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
}) {
  // Sending is blocked while the backend is unreachable: the send
  // button greys out and Enter / submit become no-ops, while the
  // draft itself stays editable so it can be sent after reconnect.
  const sendBlocked = locked || offline;
  const ref = useRef<HTMLTextAreaElement>(null);
  // Touch devices have no Shift+Enter: on a coarse primary pointer the
  // return key inserts a newline instead of sending, and the send
  // button is the only way to send.
  const [coarsePointer, setCoarsePointer] = useState(false);
  // Preview renders the draft exactly as the sent user message will
  // appear (same markdown component, same bubble). The draft itself
  // stays plain text in the textarea; previewing never edits it, and
  // toggling back restores the editor with the draft untouched.
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(pointer: coarse)');
    setCoarsePointer(query.matches);
    const onChange = (event: MediaQueryListEvent) => setCoarsePointer(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // A send clears the draft in the parent, and an empty draft always
  // means editing mode: a sent message never leaves the preview up.
  useEffect(() => {
    if (value === '') setPreviewing(false);
  }, [value]);

  // Returning from the preview remounts the textarea; put the focus
  // (and with it the software keyboard) back where the user left it,
  // so editing continues without an extra tap. Only on the way back —
  // the first mount never steals focus.
  const wasPreviewing = useRef(false);
  useEffect(() => {
    if (previewing) {
      wasPreviewing.current = true;
      return;
    }
    if (wasPreviewing.current) {
      wasPreviewing.current = false;
      ref.current?.focus({ preventScroll: true });
    }
  }, [previewing]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [value, previewing]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    if (coarsePointer) return;
    event.preventDefault();
    if (!sendBlocked) onSend();
  };

  // Buttons next to the editor act on pointerdown's default being
  // prevented: a tap must not blur the textarea first. With the
  // software keyboard up, a blur starts closing the keyboard and
  // shifts the layout mid-tap, so the tap lands nowhere and the user
  // has to press again — with the default prevented, focus (and the
  // keyboard) stay put and the click that follows sends in one tap.
  const keepEditorFocus = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
  };

  return (
    <form
      className="border-t border-line px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!sendBlocked) onSend();
      }}
    >
      <div className="flex items-end gap-2">
        <label htmlFor="chat-message" className="sr-only">
          メッセージ
        </label>
        {previewing ? (
          <div className="flex min-w-0 flex-1 justify-end">
            <article className="max-w-[min(85%,32rem)] rounded-2xl bg-user px-3 py-2">
              <CharacterMarkdown text={value} />
            </article>
          </div>
        ) : (
          <textarea
            id="chat-message"
            ref={ref}
            rows={1}
            maxLength={20000}
            value={value}
            enterKeyHint={coarsePointer ? 'enter' : 'send'}
            placeholder="メッセージを入力"
            className={`${fieldClass} max-h-40 min-h-11 resize-none`}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
        <button
          type="button"
          className={`${buttonClass} h-11`}
          aria-label={previewing ? '編集に戻る' : 'プレビュー'}
          title={previewing ? '編集に戻る' : 'プレビュー'}
          aria-pressed={previewing}
          disabled={!previewing && value.trim() === ''}
          onPointerDown={keepEditorFocus}
          onClick={() => setPreviewing((current) => !current)}
        >
          {previewing ? (
            <span className="icon-[mdi--eye-off] text-base" aria-hidden="true" />
          ) : (
            <span className="icon-[mdi--eye] text-base" aria-hidden="true" />
          )}
        </button>
        <button
          type="submit"
          className={`${primaryButtonClass} h-11`}
          aria-label="送信"
          title="送信"
          disabled={sendBlocked || value.trim() === ''}
          onPointerDown={keepEditorFocus}
        >
          <span className="icon-[mdi--send] text-base" aria-hidden="true" />
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">
        {previewing
          ? 'プレビューを表示しています'
          : coarsePointer
            ? 'Enter で改行、送信ボタンで送信'
            : 'Enter で送信、Shift+Enter で改行'}
      </p>
    </form>
  );
}
