import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { emptyTrace } from '../../lib/chatState';
import type { DisplayMessage } from '../../types/chat';
import { MessageList } from './MessageList';

describe('MessageList', () => {
  it('renders markdown for user and character messages and leaves tool payloads literal', async () => {
    const { container } = render(
      <MessageList
        messages={[
          {
            id: 'user',
            role: 'user',
            content: '**重要** [詳細](https://example.com)\n次の行\n\n$x^2$',
          },
          {
            id: 'assistant',
            role: 'assistant',
            content:
              '見ました\n\n[詳細](https://example.com)\n\n$E=mc^2$\n\n<script>alert(1)</script>',
            stateAnalysis: {
              emotion: {
                primary: 'happy',
                intensity: 0.8,
                secondary: 'surprised',
                secondary_intensity: 0.2,
                mood: '嬉しい',
              },
              affinity: { delta: 2, reason: '親切な会話' },
            },
            tools: [
              {
                id: 'tool-1',
                name: 'search_memories',
                arguments: '{"keywords":["詳細"]}',
                result: '[詳細](https://example.com)',
              },
            ],
          },
        ]}
        loading={false}
        activity={null}
        debug
        debugExpandDefault
        trace={emptyTrace}
      />,
    );

    // Markdown renders through a lazily loaded chunk; wait for the
    // math to land before asserting on the rendered output. The
    // timeout is generous: under full-suite parallel load the chunk
    // import plus the KaTeX render can exceed the default 1s.
    await waitFor(
      () => {
        expect(container.querySelector('.katex')).toBeTruthy();
      },
      { timeout: 10000 },
    );

    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute('href')).toBe('https://example.com');
    }
    // The user message goes through the same markdown path as the
    // character's: emphasis, links, line breaks, and math all render.
    const userArticle = container.querySelector('article.bg-user');
    expect(userArticle?.querySelector('strong')?.textContent).toBe('重要');
    expect(userArticle?.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(userArticle?.querySelector('.katex')).toBeTruthy();
    expect(userArticle?.textContent).toContain('次の行');
    expect(container.querySelector('.katex')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    const payloads = container.querySelectorAll('pre');
    expect(payloads[0]?.textContent).toContain('{"keywords":["詳細"]}');
    expect(payloads[1]?.textContent).toContain('[詳細](https://example.com)');
    expect(payloads[1]?.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('喜び 80% / 驚き 20%');
    expect(container.textContent).toContain('親切な会話');
    // Debug details are timeline rows and on-reply breakdowns, folded
    // with buttons rather than native details elements.
    expect(container.querySelector('details')).toBeNull();
  });

  it('offers resend under a dangling user message in normal mode', () => {
    const dangling: DisplayMessage = {
      id: 'msg-1',
      role: 'user',
      content: 'こんにちは',
      dangling: true,
    };
    const onResend = vi.fn();
    const { container } = render(
      <MessageList
        messages={[dangling]}
        loading={false}
        activity={null}
        debug={false}
        trace={emptyTrace}
        onResend={onResend}
      />,
    );
    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === '再送',
    );
    expect(button).toBeTruthy();
    if (button) fireEvent.click(button);
    expect(onResend).toHaveBeenCalledWith(dangling);

    const answered = render(
      <MessageList
        messages={[{ id: 'msg-1', role: 'user', content: 'こんにちは' }]}
        loading={false}
        activity={null}
        debug={false}
        trace={emptyTrace}
        onResend={onResend}
      />,
    );
    expect(answered.container.textContent).not.toContain('再送');
    const handlerless = render(
      <MessageList
        messages={[dangling]}
        loading={false}
        activity={null}
        debug={false}
        trace={emptyTrace}
      />,
    );
    expect(handlerless.container.textContent).not.toContain('再送');
  });

  it('renders the front-stage and pipeline blocks as timeline rows in debug mode only', () => {
    const messages = [
      {
        id: 'assistant',
        role: 'assistant' as const,
        content: '覚えてるよ',
        createdAt: '2026-11-09T00:00:10Z',
        memorySearch: {
          searches: [{ terms: ['京都', '旅行'], pointing: true, result: 'hit' as const }],
          disclosed: [
            { id: 7, content: 'ユーザーは京都旅行を計画している', delivery: 'recall' as const },
          ],
          recalled_ids: [7],
          restored_ids: [],
          created_ids: [],
          notification_terms: [],
          ask_back_ids: [],
        },
        summary: { id: 3, start_message_id: 1, end_message_id: 9 },
      },
    ];
    const jobs = [
      {
        id: 5,
        kind: 'summary' as const,
        start_message_id: 1,
        end_message_id: 2,
        conversation_epoch: 1,
        status: 'done',
        attempts: 1,
        error: null,
        result: null,
        created_at: '2026-11-09T00:00:11Z',
        updated_at: '2026-11-09T00:00:20Z',
      },
    ];
    const summaries = [
      {
        id: 3,
        content: '京都旅行の要約本文',
        start_message_id: 1,
        end_message_id: 9,
        active: true,
        archived: false,
        created_at: '2026-11-09T00:00:09Z',
      },
    ];
    const { container } = render(
      <MessageList
        messages={messages}
        loading={false}
        activity={null}
        debug
        debugExpandDefault
        trace={emptyTrace}
        jobs={jobs}
        summaries={summaries}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('前段処理');
    expect(text).toContain('京都、旅行');
    expect(text).toContain('#7 ユーザーは京都旅行を計画している');
    expect(text).toContain('想起');
    expect(text).toContain('パイプライン処理');
    expect(text).toContain('要約ジョブ #5');
    // Summary division of roles: the creation event in the pipeline
    // block is metadata only, and the body appears exactly once —
    // in the summary's own row after its covered range,
    // together with its metadata.
    expect(text).toContain('要約 #3 を作成（メッセージ #1 – #9');
    expect(text.split('京都旅行の要約本文')).toHaveLength(2);
    const summaryRow = container.querySelector('[data-mid="summary-3"]');
    expect(summaryRow).toBeTruthy();
    expect(summaryRow?.textContent).toContain('要約 #3');
    expect(summaryRow?.textContent).toContain('京都旅行の要約本文');
    expect(summaryRow?.textContent).toMatch(/\d+\/\d+/);

    // Without the expand-by-default preference the same blocks are
    // folded: the header lines (including the summary's metadata
    // label) stay, the bodies go.
    const { container: folded } = render(
      <MessageList
        messages={messages}
        loading={false}
        activity={null}
        debug
        trace={emptyTrace}
        jobs={jobs}
        summaries={summaries}
      />,
    );
    const foldedText = folded.textContent ?? '';
    expect(foldedText).toContain('前段処理');
    expect(foldedText).toContain('パイプライン処理');
    expect(foldedText).toContain('要約 #3');
    expect(foldedText).not.toContain('京都、旅行');
    expect(foldedText).not.toContain('要約ジョブ #5');
    expect(foldedText).not.toContain('京都旅行の要約本文');

    const { container: plain } = render(
      <MessageList
        messages={messages}
        loading={false}
        activity={null}
        debug={false}
        trace={emptyTrace}
        jobs={jobs}
        summaries={summaries}
      />,
    );
    expect(plain.textContent).not.toContain('前段処理');
    expect(plain.textContent).not.toContain('京都、旅行');
    expect(plain.textContent).not.toContain('パイプライン処理');
    expect(plain.textContent).not.toContain('要約ジョブ #5');
    expect(plain.textContent).not.toContain('京都旅行の要約本文');
  });

  it('shows a dangling turn front stage formatted, never as a raw metadata dump', () => {
    const record = {
      keywords: ['合言葉'],
      reminds: false,
      emotion: {
        primary: 'happy' as const,
        intensity: 0.8,
        secondary: null,
        secondary_intensity: 0,
        mood: '嬉しい',
      },
      affinity: { delta: 2, reason: '親切な会話' },
    };
    const { container } = render(
      <MessageList
        messages={[
          {
            id: 'msg-1',
            role: 'user' as const,
            content: '質問',
            dangling: true,
            frontStage: record,
            metadata: { front_stage: record },
          },
        ]}
        loading={false}
        activity={null}
        debug
        debugExpandDefault
        trace={emptyTrace}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('前段処理');
    expect(text).toContain('合言葉');
    expect(text).toContain('喜び 80%');
    expect(text).not.toContain('front_stage');
  });

  it('shows the front stage once per turn, from the reply record', () => {
    const analysis = {
      emotion: {
        primary: 'happy' as const,
        intensity: 0.8,
        secondary: null,
        secondary_intensity: 0,
        mood: '嬉しい',
      },
      affinity: { delta: 2, reason: '親切な会話' },
    };
    const { container } = render(
      <MessageList
        messages={[
          {
            id: 'msg-1',
            role: 'user' as const,
            content: '質問',
            frontStage: { ...analysis, keywords: ['ひみつの語'], reminds: false },
          },
          {
            id: 'msg-2',
            role: 'assistant' as const,
            content: '回答',
            stateAnalysis: analysis,
            memorySearch: {
              searches: [{ terms: ['公開の語'], pointing: false, result: 'no_hit' as const }],
              disclosed: [],
              recalled_ids: [],
              restored_ids: [],
              created_ids: [],
              notification_terms: [],
              ask_back_ids: [],
            },
          },
        ]}
        loading={false}
        activity={null}
        debug
        debugExpandDefault
        trace={emptyTrace}
      />,
    );
    const text = container.textContent ?? '';
    expect(text.split('前段処理')).toHaveLength(2);
    expect(text).toContain('公開の語');
    expect(text).not.toContain('ひみつの語');
    expect(text).not.toContain('front_stage');
  });

  it('folds debug blocks by default, keeps token usage visible, and toggles per block', () => {
    const { container } = render(
      <MessageList
        messages={[
          {
            id: 'msg-2',
            messageId: 2,
            role: 'assistant' as const,
            content: '回答',
            usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
            memorySearch: {
              searches: [{ terms: ['京都'], pointing: false, result: 'hit' as const }],
              disclosed: [],
              recalled_ids: [],
              restored_ids: [],
              created_ids: [],
              notification_terms: [],
              ask_back_ids: [],
            },
          },
        ]}
        loading={false}
        activity={null}
        debug
        trace={emptyTrace}
      />,
    );
    // Token usage is not part of the folding: it stays on the reply.
    expect(container.textContent).toContain('入力 120 / 出力 30 / 合計 150');
    // The message id rides along with the usage, as the purge cutoff.
    expect(container.textContent).toContain('メッセージ #2');
    // The front-stage block shows only its header while folded.
    expect(container.textContent).toContain('前段処理');
    expect(container.textContent).not.toContain('検索キーワード');

    const header = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('前段処理'),
    );
    expect(header).toBeTruthy();
    if (!header) return;
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('検索キーワード');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('検索キーワード');
  });

  it('applies an expand-by-default flip to blocks already on screen', () => {
    const messages: DisplayMessage[] = [
      {
        id: 'msg-2',
        messageId: 2,
        role: 'assistant',
        content: '回答',
        memorySearch: {
          searches: [{ terms: ['京都'], pointing: false, result: 'hit' }],
          disclosed: [],
          recalled_ids: [],
          restored_ids: [],
          created_ids: [],
          notification_terms: [],
          ask_back_ids: [],
        },
      },
    ];
    const { container, rerender } = render(
      <MessageList messages={messages} loading={false} activity={null} debug trace={emptyTrace} />,
    );
    expect(container.textContent).not.toContain('検索キーワード');
    rerender(
      <MessageList
        messages={messages}
        loading={false}
        activity={null}
        debug
        debugExpandDefault
        trace={emptyTrace}
      />,
    );
    expect(container.textContent).toContain('検索キーワード');
    rerender(
      <MessageList messages={messages} loading={false} activity={null} debug trace={emptyTrace} />,
    );
    expect(container.textContent).not.toContain('検索キーワード');
  });
});

describe('MessageList scrolling', () => {
  const baseMessages: DisplayMessage[] = [
    { id: 'u1', role: 'user', content: 'こんにちは' },
    { id: 'a1', role: 'assistant', content: 'こんにちは' },
  ];

  function renderList(messages: DisplayMessage[]) {
    return render(
      <MessageList
        messages={messages}
        loading={false}
        activity={null}
        debug={false}
        trace={emptyTrace}
      />,
    );
  }

  function stubGeometry(element: Element) {
    Object.defineProperty(element, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(element, 'clientHeight', { value: 500, configurable: true });
    const scrollTo = vi.fn();
    Object.defineProperty(element, 'scrollTo', { value: scrollTo, configurable: true });
    return scrollTo;
  }

  it('shows a jump-to-latest button while scrolled up and scrolls on click', () => {
    const { container, getByRole } = renderList(baseMessages);
    const scroller = container.querySelector('[role="log"]');
    expect(scroller).toBeTruthy();
    if (!scroller) return;
    const scrollTo = stubGeometry(scroller);
    Object.defineProperty(scroller, 'scrollTop', { value: 0, configurable: true });
    fireEvent.scroll(scroller);
    const button = getByRole('button', { name: '最新のメッセージへ' });
    fireEvent.click(button);
    expect(scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'smooth' });
  });

  it('smooth-scrolls when the user sends a message while scrolled up', () => {
    const { container, rerender } = renderList(baseMessages);
    const scroller = container.querySelector('[role="log"]');
    expect(scroller).toBeTruthy();
    if (!scroller) return;
    const scrollTo = stubGeometry(scroller);
    Object.defineProperty(scroller, 'scrollTop', { value: 0, configurable: true });
    fireEvent.scroll(scroller);
    rerender(
      <MessageList
        messages={[...baseMessages, { id: 'u2', role: 'user', content: '次の質問' }]}
        loading={false}
        activity={null}
        debug={false}
        trace={emptyTrace}
      />,
    );
    expect(scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'smooth' });
  });

  it('does not scroll for an appended reply', () => {
    const { container, rerender } = renderList(baseMessages);
    const scroller = container.querySelector('[role="log"]');
    expect(scroller).toBeTruthy();
    if (!scroller) return;
    const scrollTo = stubGeometry(scroller);
    rerender(
      <MessageList
        messages={[...baseMessages, { id: 'a2', role: 'assistant', content: '返答' }]}
        loading={false}
        activity={null}
        debug={false}
        trace={emptyTrace}
      />,
    );
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
