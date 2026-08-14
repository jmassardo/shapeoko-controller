import { describe, expect, it, vi } from 'vitest';

import { FakeTransport } from './fakeTransport.js';
import { SerialTransportError } from './types.js';

/** GRBL real-time command bytes exercised by the sender. */
const CMD_CANCEL = 0x18; // ctrl-x / soft reset
const CMD_STATUS = 0x3f; // '?' status query

describe('FakeTransport', () => {
  it('opens, emits a typed open event, and reports state', async () => {
    const transport = new FakeTransport('/dev/fake');
    const opened = vi.fn();
    transport.on('open', opened);

    expect(transport.isOpen).toBe(false);
    await transport.open();

    expect(transport.isOpen).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('delivers scripted inbound data in order once open', async () => {
    const transport = new FakeTransport();
    const chunks: Buffer[] = [];
    transport.on('data', (chunk) => chunks.push(chunk));

    await transport.open();
    transport.pushIncoming('ok\r\n');
    transport.pushIncoming(Buffer.from([0x01, 0x02]));

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.toString()).toBe('ok\r\n');
    expect(Array.from(chunks[1] ?? Buffer.alloc(0))).toEqual([0x01, 0x02]);
  });

  it('queues inbound data pushed before open and flushes it in order on open', async () => {
    const transport = new FakeTransport();
    const chunks: Buffer[] = [];
    transport.on('data', (chunk) => chunks.push(chunk));

    transport.pushIncoming('first');
    transport.pushIncoming('second');
    expect(chunks).toHaveLength(0);

    await transport.open();

    expect(chunks.map((c) => c.toString())).toEqual(['first', 'second']);
  });

  it('records outbound writes as separate chunks and as concatenated bytes', async () => {
    const transport = new FakeTransport();
    await transport.open();

    await transport.write(Buffer.from('G0 X0\n'));
    await transport.write(Buffer.from('G1 Y1\n'));

    const chunks = transport.getWrittenChunks();
    expect(chunks.map((c) => c.toString())).toEqual(['G0 X0\n', 'G1 Y1\n']);
    expect(transport.getWrittenBytes().toString()).toBe('G0 X0\nG1 Y1\n');
  });

  it('forwards write bytes without mutation and appends no newline', async () => {
    const transport = new FakeTransport();
    await transport.open();

    const payload = Buffer.from([0x00, 0x7f, 0x80, 0xff]);
    await transport.write(payload);

    const written = transport.getWrittenBytes();
    expect(Array.from(written)).toEqual([0x00, 0x7f, 0x80, 0xff]);
    expect(written.length).toBe(payload.length);
  });

  it('does not corrupt recorded output when the caller mutates its buffer afterward', async () => {
    const transport = new FakeTransport();
    await transport.open();

    const payload = Buffer.from([0xaa, 0xbb]);
    await transport.write(payload);
    payload[0] = 0x00;

    expect(Array.from(transport.getWrittenBytes())).toEqual([0xaa, 0xbb]);
  });

  it('writes exactly one raw byte with no newline for real-time commands', async () => {
    const transport = new FakeTransport();
    await transport.open();

    await transport.writeRaw(CMD_CANCEL);

    const chunks = transport.getWrittenChunks();
    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0] ?? Buffer.alloc(0))).toEqual([0x18]);
  });

  it('asserts the exact outbound byte order including interleaved raw real-time bytes', async () => {
    const transport = new FakeTransport();
    await transport.open();

    await transport.write(Buffer.from('G0 X10\n'));
    await transport.writeRaw(CMD_STATUS);
    await transport.write(Buffer.from('G1 X20\n'));
    await transport.writeRaw(CMD_CANCEL);

    // Numbers are single bytes, strings are UTF-8, buffers verbatim.
    transport.expectWritten('G0 X10\n', CMD_STATUS, Buffer.from('G1 X20\n'), CMD_CANCEL);
  });

  it('expectWritten throws a hex diff when the outbound bytes differ', async () => {
    const transport = new FakeTransport();
    await transport.open();
    await transport.writeRaw(CMD_STATUS);

    expect(() => transport.expectWritten(CMD_CANCEL)).toThrowError(/outbound byte mismatch/);
    expect(() => transport.expectWritten(CMD_CANCEL)).toThrowError(/expected: 18/);
    expect(() => transport.expectWritten(CMD_CANCEL)).toThrowError(/actual:\s+3f/);
  });

  it('rejects writeRaw for out-of-range or non-integer bytes with a typed error', async () => {
    const transport = new FakeTransport();
    await transport.open();

    await expect(transport.writeRaw(256)).rejects.toBeInstanceOf(SerialTransportError);
    await expect(transport.writeRaw(-1)).rejects.toMatchObject({ kind: 'write-failed' });
    await expect(transport.writeRaw(12.5)).rejects.toMatchObject({ kind: 'write-failed' });
    expect(transport.getWrittenChunks()).toHaveLength(0);
  });

  it('rejects writes while closed with a typed closed error', async () => {
    const transport = new FakeTransport();

    await expect(transport.write(Buffer.from('x'))).rejects.toMatchObject({
      kind: 'closed',
    });
    await expect(transport.writeRaw(CMD_STATUS)).rejects.toMatchObject({ kind: 'closed' });
  });

  it('emits a typed close event on close() and is idempotent', async () => {
    const transport = new FakeTransport();
    const closed = vi.fn();
    transport.on('close', closed);

    await transport.open();
    await transport.close();
    await transport.close();

    expect(closed).toHaveBeenCalledTimes(1);
    expect(transport.isOpen).toBe(false);
  });

  it('scriptClose simulates a device-initiated close exactly once', async () => {
    const transport = new FakeTransport();
    const closed = vi.fn();
    transport.on('close', closed);

    await transport.open();
    transport.scriptClose();
    transport.scriptClose();

    expect(closed).toHaveBeenCalledTimes(1);
    expect(transport.isOpen).toBe(false);
  });

  it('emitError delivers a typed error event to listeners', async () => {
    const transport = new FakeTransport();
    const errors: SerialTransportError[] = [];
    transport.on('error', (error) => errors.push(error));

    await transport.open();
    transport.emitError();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SerialTransportError);
    expect(errors[0]?.kind).toBe('device-error');
  });

  it('emitError with a custom typed error preserves its kind and does not throw without listeners', () => {
    const transport = new FakeTransport();

    // No 'error' listener attached: must not throw (no uncaught error).
    expect(() => transport.emitError()).not.toThrow();

    const errors: SerialTransportError[] = [];
    transport.on('error', (error) => errors.push(error));
    transport.emitError(new SerialTransportError('device-error', 'boom', '/dev/fake'));

    expect(errors[0]?.message).toBe('boom');
  });

  it('rejects open() with the scripted typed error and emits no open event', async () => {
    const transport = new FakeTransport();
    const opened = vi.fn();
    transport.on('open', opened);
    transport.scriptOpenError();

    await expect(transport.open()).rejects.toBeInstanceOf(SerialTransportError);
    await expect(transport.open()).rejects.toMatchObject({ kind: 'open-failed' });
    expect(opened).not.toHaveBeenCalled();
    expect(transport.isOpen).toBe(false);
  });

  it('honors a custom scripted open error', async () => {
    const transport = new FakeTransport('/dev/ttyGHOST');
    transport.scriptOpenError(
      new SerialTransportError('port-not-found', 'no such port', '/dev/ttyGHOST'),
    );

    await expect(transport.open()).rejects.toMatchObject({
      kind: 'port-not-found',
      path: '/dev/ttyGHOST',
    });
  });

  it('reset clears recorded output, queued input, scripted failures, and state', async () => {
    const transport = new FakeTransport();
    const chunks: Buffer[] = [];
    transport.on('data', (chunk) => chunks.push(chunk));

    await transport.open();
    await transport.write(Buffer.from('data'));
    transport.pushIncoming('queued-while-open');
    transport.reset();

    expect(transport.isOpen).toBe(false);
    expect(transport.getWrittenChunks()).toHaveLength(0);
    expect(transport.getWrittenBytes().length).toBe(0);

    // Listeners survive reset; a fresh open should not replay old queued data.
    chunks.length = 0;
    await transport.open();
    expect(chunks).toHaveLength(0);
  });

  it('exposes the configured path', () => {
    expect(new FakeTransport('/dev/ttyUSB0').path).toBe('/dev/ttyUSB0');
    expect(new FakeTransport().path).toBe('/dev/fake');
  });
});
