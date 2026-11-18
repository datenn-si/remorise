import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CharacterMarkdown } from './CharacterMarkdown';
import type { TurnTrace } from '../../lib/chatState';
import { formatDateTime } from '../../lib/format';
import {
  deliveryLabel,
  emotionLabel,
  jobKindLabel,
  jobStatusLabel,
  searchResultLabel,
} from '../../lib/labels';
import {
  buildTimeline,
  type FrontStageBlock,
  type PipelineItem,
  type TimelineSummary,
} from '../../lib/timeline';
import { buttonClass } from '../../lib/ui';
import type { DisplayMessage, StateAnalysis, ToolDebug, UsageDebug } from '../../types/chat';
import type { DebugJob, DebugSummary } from '../../types/debug';

function scrollBehavior(): ScrollBehavior {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth';
}

export function MessageList({
  messages,
  loading,
  activity,
  debug,
  debugExpandDefault = false,
  trace,
  jobs,
  summaries,
  onResend,
  hasMoreHistory,
  loadingOlderHistory,
  onLoadOlder,
  topFadeSpacer = false,
}: {
  messages: DisplayMessage[];
  loading: boolean;
  activity: string | null;
  debug: boolean;
  debugExpandDefault?: boolean;
  trace: TurnTrace;
  jobs?: DebugJob[];
  summaries?: DebugSummary[];
  onResend?: (message: DisplayMessage) => void;
  hasMoreHistory?: boolean;
  loadingOlderHistory?: boolean;
  onLoadOlder?: () => void;
  topFadeSpacer?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const prevTail = useRef<{ id: string; role: string } | undefined>(undefined);
  // Scroll height captured when an older-page load was requested, so
  // the prepend can shift scrollTop by the growth and the reading
  // position does not jump.
  const prependBase = useRef<number | null>(null);
  const firstMessageId = useRef<string | undefined>(undefined);
  // Reading anchor for layout changes that rebuild the list in place
  // (debug mode toggling inserts and removes timeline rows and swaps
  // the history underneath; debug blocks folding and unfolding change
  // row heights): the message row at the top of the
  // viewport and its offset from the container's top, captured on
  // scroll. When the layout changes, the anchor is realigned so the text
  // under the reader's eyes does not jump.
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const anchorFrame = useRef(0);
  const prevDebug = useRef(debug);
  const prevExpandDefault = useRef(debugExpandDefault);
  const pendingRestore = useRef(false);
  const restoreAttempts = useRef(0);
  // Bumped by a debug block toggle so the anchor restore below runs
  // after the fold state has rendered.
  const [layoutNonce, setLayoutNonce] = useState(0);
  // In debug mode the conversation renders as a timeline per turn:
  // user message, one front-stage block, the reply (with its token /
  // tool breakdown on the reply itself), then one pipeline block if
  // anything ran for that turn. Normal mode renders plain messages.
  // The synthesis is memoized so unrelated re-renders (activity
  // label, polls) do not rebuild it.
  const entries = useMemo(
    () => (debug ? buildTimeline(messages, jobs ?? [], summaries ?? []) : null),
    [debug, messages, jobs, summaries],
  );
  const entryCount = entries?.length ?? 0;

  const captureAnchor = useCallback(() => {
    anchorFrame.current = 0;
    const element = ref.current;
    if (!element || typeof document.elementFromPoint !== 'function') return;
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 6);
    const row = hit?.closest?.('[data-mid]');
    const id = row?.getAttribute('data-mid');
    if (row && id) {
      anchor.current = { id, offset: row.getBoundingClientRect().top - rect.top };
    }
  }, []);

  // A debug block is about to fold or unfold: capture the reading
  // anchor from the pre-toggle layout and arm the same restore the
  // debug flip uses, so the height change does not throw the scroll
  // position somewhere unrelated.
  const handleBlockToggle = useCallback(() => {
    captureAnchor();
    pendingRestore.current = true;
    restoreAttempts.current = 0;
    setLayoutNonce((nonce) => nonce + 1);
  }, [captureAnchor]);

  const onScroll = () => {
    const element = ref.current;
    if (!element) return;
    stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    setAtBottom(stick.current);
    if (!anchorFrame.current) {
      anchorFrame.current = requestAnimationFrame(captureAnchor);
    }
    if (
      element.scrollTop < 120 &&
      hasMoreHistory &&
      !loadingOlderHistory &&
      onLoadOlder &&
      prependBase.current === null
    ) {
      prependBase.current = element.scrollHeight;
      onLoadOlder();
    }
  };

  useLayoutEffect(() => {
    if (prevDebug.current === debug) return;
    prevDebug.current = debug;
    pendingRestore.current = true;
    restoreAttempts.current = 0;
  }, [debug]);

  useLayoutEffect(() => {
    if (prevExpandDefault.current === debugExpandDefault) return;
    prevExpandDefault.current = debugExpandDefault;
    pendingRestore.current = true;
    restoreAttempts.current = 0;
  }, [debugExpandDefault]);

  useLayoutEffect(() => {
    if (!pendingRestore.current) return;
    const element = ref.current;
    if (!element) return;
    restoreAttempts.current += 1;
    if (stick.current) {
      element.scrollTop = element.scrollHeight;
      pendingRestore.current = false;
      return;
    }
    const current = anchor.current;
    const row = current ? element.querySelector(`[data-mid="${CSS.escape(current.id)}"]`) : null;
    if (row) {
      element.scrollTop +=
        row.getBoundingClientRect().top - element.getBoundingClientRect().top - current!.offset;
      // The history itself may still be reloading underneath the
      // toggle; keep restoring until it settles.
      if (!loading) pendingRestore.current = false;
    } else if (restoreAttempts.current > 6) {
      pendingRestore.current = false;
    }
    // debugExpandDefault is a dependency so the restore armed by the
    // preference flip runs in the same commit in which every block
    // adopted the new default and the heights settled.
  }, [messages, entries, loading, layoutNonce, debugExpandDefault]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const head = messages[0]?.id;
    if (prependBase.current !== null) {
      // A prepend landed (the head message changed): keep the same
      // content under the reader's eyes. If the head did not change,
      // the load failed and there is nothing to compensate.
      if (
        head !== undefined &&
        firstMessageId.current !== undefined &&
        head !== firstMessageId.current
      ) {
        element.scrollTop += element.scrollHeight - prependBase.current;
      }
      prependBase.current = null;
    }
    firstMessageId.current = head;
  }, [messages, entries]);

  useEffect(() => {
    const element = ref.current;
    if (!element || !stick.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, activity, entryCount]);

  // A send appends the user's own message at the tail: follow it
  // with a smooth scroll even when the reader had scrolled up to
  // reread. History loads and prepends never end in a brand-new
  // user message, and the first load has no previous tail to
  // compare against, so neither triggers this.
  useEffect(() => {
    const tail = messages[messages.length - 1];
    const previous = prevTail.current;
    prevTail.current = tail ? { id: tail.id, role: tail.role } : undefined;
    if (!tail || !previous || tail.role !== 'user' || tail.id === previous.id) return;
    const element = ref.current;
    if (!element) return;
    stick.current = true;
    setAtBottom(true);
    element.scrollTo({ top: element.scrollHeight, behavior: scrollBehavior() });
  }, [messages]);

  const jumpToLatest = () => {
    const element = ref.current;
    if (!element) return;
    stick.current = true;
    setAtBottom(true);
    element.scrollTo({ top: element.scrollHeight, behavior: scrollBehavior() });
  };

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      role="log"
      aria-label="会話"
    >
      {topFadeSpacer ? (
        // On mobile the column's top is masked by the sprite fade
        // (see .sprite-fg-fade in index.css): without this spacer the
        // very first message would sit inside that fade distance and
        // render washed out even at the top of the history.
        <div
          aria-hidden="true"
          className="max-md:h-[min(var(--sprite-overlap),var(--sprite-fade))]"
        />
      ) : null}
      {loading && messages.length === 0 ? (
        <p className="text-sm text-muted">会話履歴を読み込んでいます。</p>
      ) : null}
      {!loading && messages.length === 0 ? (
        <p className="text-sm text-muted">まだ会話はありません。メッセージを送ってみてください。</p>
      ) : null}
      {loadingOlderHistory ? (
        <p className="pb-2 text-center text-xs text-muted">過去の会話を読み込んでいます。</p>
      ) : null}
      <ol className="space-y-4">
        {entries
          ? entries.map((entry) => {
              if (entry.type === 'message') {
                return (
                  <MessageItem
                    key={entry.id}
                    message={entry.message}
                    debug={debug}
                    debugExpandDefault={debugExpandDefault}
                    onToggleLayout={handleBlockToggle}
                    onResend={onResend}
                  />
                );
              }
              if (entry.type === 'front') {
                return (
                  <FrontStageRow
                    key={entry.id}
                    rowId={entry.id}
                    block={entry.block}
                    defaultOpen={debugExpandDefault}
                    onToggleLayout={handleBlockToggle}
                  />
                );
              }
              if (entry.type === 'summary') {
                return (
                  <SummaryRow
                    key={entry.id}
                    rowId={entry.id}
                    summary={entry.summary}
                    defaultOpen={debugExpandDefault}
                    onToggleLayout={handleBlockToggle}
                  />
                );
              }
              return (
                <PipelineRow
                  key={entry.id}
                  rowId={entry.id}
                  items={entry.items}
                  defaultOpen={debugExpandDefault}
                  onToggleLayout={handleBlockToggle}
                />
              );
            })
          : messages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                debug={debug}
                debugExpandDefault={debugExpandDefault}
                onToggleLayout={handleBlockToggle}
                onResend={onResend}
              />
            ))}
      </ol>
      {debug ? (
        <ReplyBreakdown
          tools={trace.tools}
          usage={trace.usage}
          defaultOpen={debugExpandDefault}
          onToggleLayout={handleBlockToggle}
        />
      ) : null}
      {!atBottom && (
        <div className="pointer-events-none sticky bottom-2 z-10 flex justify-center">
          {/* Pointer down must not blur the editor, or the software
              keyboard closes before the tap lands (same as the
              composer buttons). */}
          <button
            type="button"
            onClick={jumpToLatest}
            onPointerDown={(event) => event.preventDefault()}
            aria-label="最新のメッセージへ"
            className={`${buttonClass} pointer-events-auto shadow-lg`}
          >
            <span className="icon-[mdi--arrow-down] text-xl" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

// Memoized: while a reply streams in, only its own message object
// changes identity (the reducer keeps the rest stable), so settled
// messages skip re-rendering — and re-parsing their markdown — on
// every token.
const MessageItem = memo(function MessageItem({
  message,
  debug,
  debugExpandDefault,
  onToggleLayout,
  onResend,
}: {
  message: DisplayMessage;
  debug: boolean;
  debugExpandDefault: boolean;
  onToggleLayout: () => void;
  onResend?: (message: DisplayMessage) => void;
}) {
  const mine = message.role === 'user';
  const body = (
    <>
      <CharacterMarkdown text={message.content} />
      {message.status === 'failed' && (
        <p className="mt-1 text-xs text-danger">生成に失敗した応答</p>
      )}
      {message.archived && (
        <p className="mt-1 text-xs text-muted">無効化されたメッセージ（忘却により表示対象外）</p>
      )}
      {debug && (
        <ReplyBreakdown
          tools={message.tools}
          usage={message.usage}
          messageId={message.messageId}
          defaultOpen={debugExpandDefault}
          onToggleLayout={onToggleLayout}
        />
      )}
      {message.createdAt && (
        <time dateTime={message.createdAt} className="mt-1 block text-xs text-muted">
          {formatDateTime(message.createdAt)}
        </time>
      )}
    </>
  );
  if (mine) {
    return (
      <li data-mid={message.id} className="flex flex-col items-end">
        <article className="max-w-[min(85%,32rem)] rounded-2xl bg-user px-3 py-2">{body}</article>
        {message.dangling && onResend ? (
          <button
            type="button"
            className="mt-1 cursor-pointer text-xs text-muted underline hover:text-ink"
            onClick={() => onResend(message)}
          >
            再送
          </button>
        ) : null}
      </li>
    );
  }
  return (
    <li data-mid={message.id}>
      <article>{body}</article>
    </li>
  );
});

/**
 * Fold state for one debug block. Blocks follow the shared default
 * (folded unless the expand-by-default preference is on): when the
 * preference flips, every block adopts it on the spot, wiping any
 * manual toggles; a manual toggle then holds until the next flip.
 * Toggling reports the layout change first, while the pre-toggle
 * layout is still on screen, so the list can hold its reading anchor
 * (see handleBlockToggle in MessageList).
 */
function useBlockOpen(defaultOpen: boolean, onToggleLayout: () => void) {
  const [open, setOpen] = useState(defaultOpen);
  const [adoptedDefault, setAdoptedDefault] = useState(defaultOpen);
  if (defaultOpen !== adoptedDefault) {
    setAdoptedDefault(defaultOpen);
    setOpen(defaultOpen);
  }
  const toggle = useCallback(() => {
    onToggleLayout();
    setOpen((value) => !value);
  }, [onToggleLayout]);
  return { open, toggle };
}

function BlockToggle({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-1 text-left"
    >
      <span
        className={`${
          open ? 'icon-[mdi--chevron-down]' : 'icon-[mdi--chevron-right]'
        } shrink-0 text-sm`}
        aria-hidden="true"
      />
      <span className="min-w-0">{children}</span>
    </button>
  );
}

/**
 * A reply's generation breakdown, shown on the reply itself in debug
 * mode: token usage (with the message id, the manual purge's cutoff
 * reference) and the tool calls the generation made. The
 * token usage stays visible at all times; the tool calls fold like
 * the other debug blocks. Pipeline
 * events live in the timeline blocks instead, and raw message
 * metadata is never dumped.
 */
function ReplyBreakdown({
  tools,
  usage,
  messageId,
  defaultOpen,
  onToggleLayout,
}: {
  tools?: ToolDebug[];
  usage?: UsageDebug | null;
  messageId?: number;
  defaultOpen: boolean;
  onToggleLayout: () => void;
}) {
  if (!tools?.length && !usage) return null;
  return (
    <div className="mt-2 border-t border-line/60 pt-2 text-xs text-muted">
      {usage && (
        <p>
          入力 {usage.promptTokens.toLocaleString()} / 出力{' '}
          {usage.completionTokens.toLocaleString()} / 合計 {usage.totalTokens.toLocaleString()}
          {messageId !== undefined && <> ・ メッセージ #{messageId}</>}
        </p>
      )}
      {!usage && messageId !== undefined && <p>メッセージ #{messageId}</p>}
      {tools?.length ? (
        <ToolsBreakdown tools={tools} defaultOpen={defaultOpen} onToggleLayout={onToggleLayout} />
      ) : null}
    </div>
  );
}

function ToolsBreakdown({
  tools,
  defaultOpen,
  onToggleLayout,
}: {
  tools: ToolDebug[];
  defaultOpen: boolean;
  onToggleLayout: () => void;
}) {
  const { open, toggle } = useBlockOpen(defaultOpen, onToggleLayout);
  return (
    <div className="mt-1">
      <BlockToggle open={open} onToggle={toggle}>
        ツール呼び出し
      </BlockToggle>
      {open &&
        tools.map((tool, index) => (
          <div key={`${tool.id}-${index}`} className="mt-2 rounded-lg border border-line p-2">
            <p>
              <span className="text-muted">名前 </span>
              <span className="text-ink">{tool.name || 'ツール'}</span>
            </p>
            {tool.arguments ? (
              <>
                <p className="mt-2">リクエスト</p>
                <pre className="mt-1 rounded-md bg-canvas p-2 font-sans break-all whitespace-pre-wrap text-ink">
                  {tool.arguments}
                </pre>
              </>
            ) : null}
            {tool.result !== null ? (
              <>
                <p className="mt-2">レスポンス</p>
                <pre className="mt-1 rounded-md bg-canvas p-2 font-sans break-all whitespace-pre-wrap text-ink">
                  {tool.result}
                </pre>
              </>
            ) : null}
          </div>
        ))}
    </div>
  );
}

function FrontStageRow({
  rowId,
  block,
  defaultOpen,
  onToggleLayout,
}: {
  rowId: string;
  block: FrontStageBlock;
  defaultOpen: boolean;
  onToggleLayout: () => void;
}) {
  const { open, toggle } = useBlockOpen(defaultOpen, onToggleLayout);
  const search = block.search;
  return (
    <li data-mid={rowId} className="flex justify-center">
      <div className="w-full max-w-[min(85%,32rem)] rounded-xl border border-dashed border-line bg-canvas/60 px-3 py-2 text-xs text-muted">
        <BlockToggle open={open} onToggle={toggle}>
          <span className="text-ink">前段処理</span>
        </BlockToggle>
        {open && (
          <>
            {block.analysis && <StateAnalysisDetails analysis={block.analysis} />}
            <p className="mt-1">
              <span className="text-muted">検索キーワード </span>
              <span className="text-ink">
                {block.keywords.length > 0 ? block.keywords.join('、') : '（なし）'}
              </span>
            </p>
            {search && search.searches.length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {search.searches.map((entry, index) => (
                  <li key={index} className="break-words">
                    検索: <span className="text-ink">{entry.terms.join('、') || '（語なし）'}</span>
                    {entry.pointing ? '（指摘あり）' : ''} → {searchResultLabel(entry.result)}
                  </li>
                ))}
              </ul>
            ) : null}
            {search && search.disclosed.length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {search.disclosed.map((hit) => (
                  <li key={hit.id} className="break-words text-ink">
                    #{hit.id} {hit.content}（{deliveryLabel(hit.delivery)}）
                  </li>
                ))}
              </ul>
            ) : search ? (
              <p className="mt-1">開示された記憶はありません。</p>
            ) : null}
            {search && search.recalled_ids.length > 0 ? (
              <p className="mt-1">想起: {search.recalled_ids.map((id) => `#${id}`).join(' ')}</p>
            ) : null}
            {search && search.restored_ids.length > 0 ? (
              <p className="mt-1">復帰: {search.restored_ids.map((id) => `#${id}`).join(' ')}</p>
            ) : null}
            {search && search.created_ids.length > 0 ? (
              <p className="mt-1">新規作成: {search.created_ids.map((id) => `#${id}`).join(' ')}</p>
            ) : null}
            {search && search.notification_terms.length > 0 ? (
              <p className="mt-1">
                「{search.notification_terms.join('、')}
                」に関連して何か忘れている、と通知されました。
              </p>
            ) : null}
            {search && search.ask_back_ids.length > 0 ? (
              <p className="mt-1">
                時期の聞き返し対象: {search.ask_back_ids.map((id) => `#${id}`).join(' ')}
              </p>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}

/**
 * A summary itself, standing right after the last message of its
 * covered range. It folds like the other debug blocks — folded
 * unless the expand-by-default preference is on; opening
 * it shows the body together with its metadata (id, covered range,
 * creation time). Its lifecycle state is part of the label:
 * superseded (replaced as the context grew) and invalidated (its
 * whole range forgotten) summaries stay visible here, marked, and
 * never come back into use. The creation event in the creating
 * turn's pipeline block carries metadata only — the body lives
 * here, with the artifact.
 */
function SummaryRow({
  rowId,
  summary,
  defaultOpen,
  onToggleLayout,
}: {
  rowId: string;
  summary: TimelineSummary;
  defaultOpen: boolean;
  onToggleLayout: () => void;
}) {
  const { open, toggle } = useBlockOpen(defaultOpen, onToggleLayout);
  const state = summary.archived ? '・無効化済み' : summary.active ? '' : '・置き換え済み';
  return (
    <li data-mid={rowId} className="flex justify-center">
      <div className="w-full max-w-[min(85%,32rem)] px-3 py-1 text-xs text-ink">
        <BlockToggle open={open} onToggle={toggle}>
          要約 #{summary.id}（メッセージ #{summary.start_message_id} – #{summary.end_message_id}
          の要約{state}
          {summary.created_at ? ` ・ ${formatDateTime(summary.created_at)}` : ''}）
        </BlockToggle>
        {open &&
          (summary.content ? (
            <p className="mt-1 break-words whitespace-pre-wrap">{summary.content}</p>
          ) : (
            <p className="mt-1">（本文を取得できませんでした）</p>
          ))}
      </div>
    </li>
  );
}

function PipelineRow({
  rowId,
  items,
  defaultOpen,
  onToggleLayout,
}: {
  rowId: string;
  items: PipelineItem[];
  defaultOpen: boolean;
  onToggleLayout: () => void;
}) {
  const { open, toggle } = useBlockOpen(defaultOpen, onToggleLayout);
  return (
    <li data-mid={rowId} className="flex justify-center">
      <div className="w-full max-w-[min(85%,32rem)] rounded-xl border border-dashed border-line bg-canvas/60 px-3 py-2 text-xs text-muted">
        <BlockToggle open={open} onToggle={toggle}>
          <span className="text-ink">パイプライン処理</span>
        </BlockToggle>
        {open && items.map((item, index) => <PipelineItemRow key={index} item={item} />)}
      </div>
    </li>
  );
}

function PipelineItemRow({ item }: { item: PipelineItem }) {
  if (item.type === 'summary') {
    // The creation event is metadata only; the body lives with the
    // summary item itself, after its covered range.
    return (
      <p className="mt-1">
        <span className="text-ink">要約 #{item.summary.id} を作成</span>（メッセージ #
        {item.summary.start_message_id} – #{item.summary.end_message_id}
        {item.summary.created_at ? ` ・ ${formatDateTime(item.summary.created_at)}` : ''}）
      </p>
    );
  }
  const job = item.job;
  if (item.type === 'job_registered') {
    return (
      <p className="mt-1">
        <span className="text-ink">
          {jobKindLabel(job.kind)}ジョブ #{job.id} を登録
        </span>{' '}
        （対象メッセージ #{job.start_message_id} – #{job.end_message_id} ・ 世代{' '}
        {job.conversation_epoch} ・ {formatDateTime(job.created_at)}）
      </p>
    );
  }
  return (
    <div className="mt-1">
      <p>
        <span className="text-ink">
          {jobKindLabel(job.kind)}ジョブ #{job.id} が{jobStatusLabel(job.status)}
        </span>{' '}
        （試行 {job.attempts} 回 ・ {formatDateTime(job.updated_at)}）
      </p>
      {job.error ? <p className="mt-1 text-danger">{job.error}</p> : null}
    </div>
  );
}

function StateAnalysisDetails({ analysis }: { analysis: StateAnalysis }) {
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      <dt>感情</dt>
      <dd className="text-ink">
        {emotionLabel(analysis.emotion.primary)} {Math.round(analysis.emotion.intensity * 100)}%
        {analysis.emotion.secondary
          ? ` / ${emotionLabel(analysis.emotion.secondary)} ${Math.round(analysis.emotion.secondary_intensity * 100)}%`
          : ''}
      </dd>
      <dt>気分</dt>
      <dd className="break-words text-ink">{analysis.emotion.mood}</dd>
      <dt>好感度</dt>
      <dd className="text-ink">
        {analysis.affinity.delta > 0 ? '+' : ''}
        {analysis.affinity.delta}
      </dd>
      {analysis.affinity.reason ? (
        <>
          <dt>理由</dt>
          <dd className="break-words text-ink">{analysis.affinity.reason}</dd>
        </>
      ) : null}
    </dl>
  );
}
