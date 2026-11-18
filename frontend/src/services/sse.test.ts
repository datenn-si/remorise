import { describe, expect, it } from 'vitest';
import { createSseParser } from './sse';

describe('createSseParser', () => {
  it('joins chunks that split an event', () => {
    const parser = createSseParser();
    expect(parser.push('event: token\ndata: {"content":"')).toEqual([]);
    expect(parser.push('あ"}\n\n')).toEqual([{ event: 'token', data: '{"content":"あ"}' }]);
  });

  it('reads several events from one chunk and ignores comments', () => {
    const parser = createSseParser();
    const chunk = [
      ': keep-alive',
      '',
      'event: message_start',
      'data: {"message_id":1}',
      '',
      'event: token',
      'data: {"content":"hi"}',
      '',
      '',
    ].join('\n');
    expect(parser.push(chunk)).toEqual([
      { event: 'message_start', data: '{"message_id":1}' },
      { event: 'token', data: '{"content":"hi"}' },
    ]);
  });

  it('accepts CRLF frames and flushes a trailing event', () => {
    const parser = createSseParser();
    expect(parser.push('event: token\r\ndata: {"content":"x"}\r\n\r\n')).toEqual([
      { event: 'token', data: '{"content":"x"}' },
    ]);
    expect(parser.push('event: error\ndata: {"code":"generation_failed"}')).toEqual([]);
    expect(parser.flush()).toEqual([{ event: 'error', data: '{"code":"generation_failed"}' }]);
  });

  it('joins continued data lines', () => {
    const parser = createSseParser();
    expect(parser.push('event: token\ndata: {"content":\ndata: "x"}\n\n')).toEqual([
      { event: 'token', data: '{"content":\n"x"}' },
    ]);
  });
});
