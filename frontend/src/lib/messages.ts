import {
  isFrontStageDebug,
  isMemorySearchDebug,
  isStateAnalysis,
  isSummaryDebug,
  type DisplayMessage,
  type HistoryMessage,
  type ToolDebug,
  type UsageDebug,
} from '../types/chat';

export function toDisplayMessages(messages: HistoryMessage[]): DisplayMessage[] {
  const visible: DisplayMessage[] = [];
  let pending: ToolDebug[] = [];
  // The last user message is dangling when no final assistant reply
  // follows it in the raw history (an assistant row without tool calls
  // is a saved reply; tool-call rows and tool results are turn debris).
  // It is judged on the raw rows, not the visible ones, so a saved but
  // empty reply still counts as answered. Archived rows (present only
  // in debug loads) are not part of the live conversation: they never
  // open a dangling turn and never answer one.
  let lastUserIndex = -1;
  let answered = false;
  messages.forEach((message, index) => {
    if (message.archived) return;
    if (message.role === 'user') {
      lastUserIndex = index;
      answered = false;
    } else if (lastUserIndex >= 0 && message.role === 'assistant' && !message.tool_calls?.length) {
      answered = true;
    }
  });
  const danglingId = lastUserIndex >= 0 && !answered ? `msg-${messages[lastUserIndex]?.id}` : null;
  for (const message of messages) {
    if (message.role === 'tool') {
      const id = message.tool_call_id ?? '';
      const match = pending.find((tool) => tool.id === id && tool.result === null);
      if (match) match.result = message.content;
      else pending.push({ id, name: '', arguments: '', result: message.content });
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        const parsed = readCall(call);
        if (!parsed) continue;
        const existing = pending.find((tool) => tool.id !== '' && tool.id === parsed.id);
        if (existing) {
          if (!existing.name) existing.name = parsed.name;
          if (!existing.arguments) existing.arguments = parsed.arguments;
        } else {
          pending.push(parsed);
        }
      }
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (message.role === 'assistant' && message.content.trim() === '') continue;
    const metadata =
      message.metadata && Object.keys(message.metadata).length > 0 ? message.metadata : null;
    const tools = message.role === 'assistant' && pending.length > 0 ? pending : undefined;
    if (message.role === 'assistant') pending = [];
    visible.push({
      id: `msg-${message.id}`,
      messageId: message.id,
      role: message.role,
      content: message.content,
      archived: message.archived ? true : undefined,
      dangling: `msg-${message.id}` === danglingId ? true : undefined,
      createdAt: message.created_at,
      metadata,
      frontStage:
        metadata && isFrontStageDebug(metadata.front_stage) ? metadata.front_stage : undefined,
      stateAnalysis:
        metadata && isStateAnalysis(metadata.state_analysis) ? metadata.state_analysis : undefined,
      memorySearch:
        metadata && isMemorySearchDebug(metadata.memory_search)
          ? metadata.memory_search
          : undefined,
      summary: metadata && isSummaryDebug(metadata.summary) ? metadata.summary : undefined,
      tools,
      usage: usageFrom(metadata),
    });
  }
  return visible;
}

function readCall(value: unknown): ToolDebug | null {
  if (!isRecord(value)) return null;
  const fn = isRecord(value.function) ? value.function : null;
  const name = typeof fn?.name === 'string' ? fn.name : '';
  const args = typeof fn?.arguments === 'string' ? fn.arguments : '';
  const id = typeof value.id === 'string' ? value.id : '';
  if (!name && !id) return null;
  return { id, name, arguments: args, result: null };
}

function usageFrom(metadata: Record<string, unknown> | null): UsageDebug | undefined {
  const usage = metadata && isRecord(metadata.usage) ? metadata.usage : null;
  if (!usage) return undefined;
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  const totalTokens = usage.total_tokens;
  if (
    typeof promptTokens !== 'number' ||
    typeof completionTokens !== 'number' ||
    typeof totalTokens !== 'number'
  ) {
    return undefined;
  }
  return { promptTokens, completionTokens, totalTokens };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
