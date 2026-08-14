import { describe, expect, it, vi } from 'vitest';

import { SerialPortTransport } from './transport.js';
import {
  SerialTransportError,
  type SerialPortFactory,
  type SerialPortOpenOptions,
} from './types.js';

/** GRBL real-time command bytes. */
const CMD_CANCEL = 0x18;
const CMD_STATUS = 0x3f;

type Listener = (...args: unknown[]) => void;

/**
 * A synchronous, hardware-free {@link SerialPortLike} double that records the
 * options it was constructed with, controls the open/write callbacks, and lets a
 * test drive `data`/`close`/`error` events exactly like the real binding.
 */
class MockSerialPort {
  isOpen = false;
  openCalls = 0;
  closeCalls = 0;
  readonly writes: Buffer[] = [];
  readonly removed: Array<{ event: string }> = [];

  /** When set, `open()` invokes its callback with this error. */
  openError: Error | null = null;
  /** When set, `write()` invokes its callback with this error. */
  writeError: Error | null = null;

  readonly #listeners = new Map<string, Listener[]>();

  open(callback: (error: Error | null) => void): void {
    this.openCalls += 1;
    if (this.openError) {
      callback(this.openError);
      return;
    }
    this.isOpen = true;
    callback(null);
  }

  write(data: Buffer, callback: (error: Error | null | undefined) => void): boolean {
    this.writes.push(Buffer.from(data));
    callback(this.writeError);
    return true;
  }

  close(callback: (error: Error | null) => void): void {
    this.closeCalls += 1;
    this.isOpen = false;
    callback(null);
    // The real binding emits a 'close' event after the callback resolves.
    this.fire('close');
  }

  on(event: string, listener: Listener): this {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    this.removed.push({ event });
    const list = this.#listeners.get(event);
    if (list) {
      this.#listeners.set(
        event,
        list.filter((l) => l !== listener),
      );
    }
    return this;
  }

  /** Drive an underlying event exactly as the binding would. */
  fire(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  listenerCount(event: string): number {
    return this.#listeners.get(event)?.length ?? 0;
  }
}

/** Build a transport wired to a fresh mock and expose both for assertions. */
function makeTransport(path = '/dev/ttyUSB0'): {
  transport: SerialPortTransport;
  mock: MockSerialPort;
  optionsSeen: SerialPortOpenOptions[];
} {
  const mock = new MockSerialPort();
  const optionsSeen: SerialPortOpenOptions[] = [];
  const factory: SerialPortFactory = (options) => {
    optionsSeen.push(options);
    return mock;
  };
  return { transport: new SerialPortTransport(path, factory), mock, optionsSeen };
}

describe('SerialPortTransport', () => {
  it('opens at 115200 8-N-1 with no flow control and emits a typed open event', async () => {
    const { transport, mock, optionsSeen } = makeTransport('/dev/ttyUSB0');
    const opened = vi.fn();
    transport.on('open', opened);

    await transport.open();

    expect(optionsSeen).toHaveLength(1);
    expect(optionsSeen[0]).toEqual({
      path: '/dev/ttyUSB0',
      baudRate: 115200,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      rtscts: false,
      xon: false,
      xoff: false,
      xany: false,
      autoOpen: false,
    });
    expect(mock.openCalls).toBe(1);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(transport.isOpen).toBe(true);
  });

  it('forwards write bytes to the underlying port without mutation and with no newline', async () => {
    const { transport, mock } = makeTransport();
    await transport.open();

    const payload = Buffer.from([0x47, 0x30, 0x0a]); // "G0\n"
    await transport.write(payload);

    expect(mock.writes).toHaveLength(1);
    expect(Array.from(mock.writes[0] ?? Buffer.alloc(0))).toEqual([0x47, 0x30, 0x0a]);
  });

  it('writeRaw writes exactly one byte with no newline appended', async () => {
    const { transport, mock } = makeTransport();
    await transport.open();

    await transport.writeRaw(CMD_CANCEL);
    await transport.writeRaw(CMD_STATUS);

    expect(mock.writes).toHaveLength(2);
    expect(mock.writes[0]?.length).toBe(1);
    expect(Array.from(mock.writes[0] ?? Buffer.alloc(0))).toEqual([0x18]);
    expect(mock.writes[1]?.length).toBe(1);
    expect(Array.from(mock.writes[1] ?? Buffer.alloc(0))).toEqual([0x3f]);
  });

  it('rejects writeRaw for out-of-range or non-integer bytes without writing', async () => {
    const { transport, mock } = makeTransport();
    await transport.open();

    await expect(transport.writeRaw(256)).rejects.toMatchObject({ kind: 'write-failed' });
    await expect(transport.writeRaw(-1)).rejects.toMatchObject({ kind: 'write-failed' });
    await expect(transport.writeRaw(3.14)).rejects.toBeInstanceOf(SerialTransportError);
    expect(mock.writes).toHaveLength(0);
  });

  it('rejects writes when the transport is not open', async () => {
    const { transport } = makeTransport();

    await expect(transport.write(Buffer.from('x'))).rejects.toMatchObject({ kind: 'closed' });
    await expect(transport.writeRaw(CMD_STATUS)).rejects.toMatchObject({ kind: 'closed' });
  });

  it('rejects a failed write with a typed write-failed error', async () => {
    const { transport, mock } = makeTransport();
    await transport.open();
    mock.writeError = new Error('EIO write failure');

    await expect(transport.write(Buffer.from('x'))).rejects.toMatchObject({
      kind: 'write-failed',
    });
  });

  it('rejects open() for a nonexistent port with a typed error and emits no open event', async () => {
    const { transport, mock } = makeTransport('/dev/ttyGHOST');
    const opened = vi.fn();
    transport.on('open', opened);
    // The binding rejects a missing path with a plain Error whose .code is undefined.
    mock.openError = new Error('No such file or directory, cannot open /dev/ttyGHOST');

    await expect(transport.open()).rejects.toBeInstanceOf(SerialTransportError);
    expect(opened).not.toHaveBeenCalled();
    expect(transport.isOpen).toBe(false);
  });

  it('surfaces the open failure as kind "open-failed" carrying path and cause', async () => {
    const { transport, mock } = makeTransport('/dev/ttyGHOST');
    const cause = new Error('cannot open');
    mock.openError = cause;

    await expect(transport.open()).rejects.toMatchObject({
      kind: 'open-failed',
      path: '/dev/ttyGHOST',
      cause,
    });
  });

  it('rejects open() with a typed error when the factory throws synchronously', async () => {
    const factory: SerialPortFactory = () => {
      throw new Error('invalid options');
    };
    const transport = new SerialPortTransport('/dev/ttyUSB0', factory);
    const opened = vi.fn();
    transport.on('open', opened);

    await expect(transport.open()).rejects.toMatchObject({ kind: 'open-failed' });
    expect(opened).not.toHaveBeenCalled();
  });

  it('emits data events for inbound chunks from the underlying port', async () => {
    const { transport, mock } = makeTransport();
    const chunks: Buffer[] = [];
    transport.on('data', (chunk) => chunks.push(chunk));

    await transport.open();
    mock.fire('data', Buffer.from('ok\r\n'));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.toString()).toBe('ok\r\n');
  });

  it('propagates an unplug as typed error and close events without throwing', async () => {
    const { transport, mock } = makeTransport();
    const errors: SerialTransportError[] = [];
    const closed = vi.fn();
    transport.on('error', (error) => errors.push(error));
    transport.on('close', closed);

    await transport.open();

    // A disconnect surfaces as an error then a close; neither may throw out of band.
    expect(() => mock.fire('error', new Error('device unplugged'))).not.toThrow();
    expect(() => mock.fire('close')).not.toThrow();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SerialTransportError);
    expect(errors[0]?.kind).toBe('device-error');
    expect(closed).toHaveBeenCalledTimes(1);
    expect(transport.isOpen).toBe(false);
  });

  it('does not throw when the underlying port errors with no error listener attached', async () => {
    const { transport, mock } = makeTransport();
    await transport.open();

    // No 'error' listener: a raw EventEmitter would throw; the transport must not.
    expect(() => mock.fire('error', new Error('unobserved'))).not.toThrow();
  });

  it('emits a single close event on device-initiated close (no double emit)', async () => {
    const { transport, mock } = makeTransport();
    const closed = vi.fn();
    transport.on('close', closed);

    await transport.open();
    mock.fire('close');
    mock.fire('close');

    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('close() is idempotent, resolves, and removes all underlying listeners', async () => {
    const { transport, mock } = makeTransport();
    const closed = vi.fn();
    transport.on('close', closed);

    await transport.open();
    await transport.close();
    await transport.close();

    expect(mock.closeCalls).toBe(1);
    expect(closed).toHaveBeenCalledTimes(1);
    // All three subscriptions (data/close/error) were torn down exactly once.
    const removedEvents = mock.removed.map((r) => r.event).sort();
    expect(removedEvents).toEqual(['close', 'data', 'error']);
    expect(mock.listenerCount('data')).toBe(0);
    expect(mock.listenerCount('close')).toBe(0);
    expect(mock.listenerCount('error')).toBe(0);
  });

  it('close() on a never-opened transport resolves without touching a port', async () => {
    const { transport, mock } = makeTransport();
    await expect(transport.close()).resolves.toBeUndefined();
    expect(mock.closeCalls).toBe(0);
  });

  it('open() is idempotent and does not construct a second port', async () => {
    const { transport, optionsSeen } = makeTransport();
    await transport.open();
    await transport.open();
    expect(optionsSeen).toHaveLength(1);
  });

  it('exposes the configured path', () => {
    const { transport } = makeTransport('/dev/ttyACM0');
    expect(transport.path).toBe('/dev/ttyACM0');
  });
});
