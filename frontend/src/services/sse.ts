export type SseEvent = {
  event: string;
  data: string;
};

export type SseParser = {
  push: (chunk: string) => SseEvent[];
  flush: () => SseEvent[];
};

export function createSseParser(): SseParser {
  let buffer = '';

  const take = (final: boolean): SseEvent[] => {
    const events: SseEvent[] = [];
    while (buffer.includes('\n\n')) {
      const splitAt = buffer.indexOf('\n\n');
      const raw = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      const event = parseBlock(raw);
      if (event) events.push(event);
    }
    if (final && buffer.trim()) {
      const event = parseBlock(buffer);
      buffer = '';
      if (event) events.push(event);
    }
    return events;
  };

  return {
    push(chunk: string) {
      buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      return take(false);
    },
    flush() {
      return take(true);
    },
  };
}

function parseBlock(raw: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const eventValue = field(line, 'event');
    if (eventValue !== null) {
      event = eventValue;
      continue;
    }
    const dataValue = field(line, 'data');
    if (dataValue !== null) data.push(dataValue);
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

function field(line: string, name: string): string | null {
  if (line === name) return '';
  const prefix = `${name}:`;
  if (!line.startsWith(prefix)) return null;
  const value = line.slice(prefix.length);
  return value.startsWith(' ') ? value.slice(1) : value;
}
