/**
 * Deterministic in-memory {@link SerialTransport} double for tests.
 *
 * {@link FakeTransport} implements the exact transport contract without any
 * hardware, sockets, or timers. Test code scripts inbound board responses with
 * {@link FakeTransport.pushIncoming}, records every outbound write (including raw
 * real-time bytes), and asserts the precise outbound byte order with
 * {@link FakeTransport.expectWritten}. Every observable transition is
 * synchronous, so tests never race a `setTimeout`.
 */

import {
  SerialTransportError,
  TypedEventEmitter,
  type SerialTransport,
  type SerialTransportEventMap,
} from './types.js';

const MAX_BYTE = 0xff;

/** A single item accepted by {@link FakeTransport.expectWritten}. */
export type ExpectedWrite = number | Buffer | string;

/**
 * In-memory bidirectional pipe implementing {@link SerialTransport}.
 */
export class FakeTransport
  extends TypedEventEmitter<SerialTransportEventMap>
  implements SerialTransport
{
  readonly #path: string;

  #state: 'closed' | 'open' = 'closed';
  #writtenChunks: Buffer[] = [];
  #incomingQueue: Buffer[] = [];
  #scriptedOpenError: SerialTransportError | undefined;

  constructor(path = '/dev/fake') {
    super();
    this.#path = path;
  }

  /** The configured (virtual) port path. */
  get path(): string {
    return this.#path;
  }

  /** Whether the fake port is currently open. */
  get isOpen(): boolean {
    return this.#state === 'open';
  }

  open(): Promise<void> {
    if (this.#state === 'open') {
      return Promise.resolve();
    }

    if (this.#scriptedOpenError !== undefined) {
      // Mirror the real transport: on open failure emit NOTHING and reject with
      // the typed error.
      return Promise.reject(this.#scriptedOpenError);
    }

    this.#state = 'open';
    this.emit('open');

    // Flush any board responses scripted before the port was opened, in order.
    const queued = this.#incomingQueue;
    this.#incomingQueue = [];
    for (const chunk of queued) {
      this.emit('data', chunk);
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.#state === 'closed') {
      return Promise.resolve();
    }
    this.#state = 'closed';
    this.emit('close');
    return Promise.resolve();
  }

  write(data: Buffer): Promise<void> {
    if (this.#state !== 'open') {
      return Promise.reject(
        new SerialTransportError(
          'closed',
          `Cannot write to fake serial port ${this.#path}: transport is not open`,
          this.#path,
        ),
      );
    }
    // Copy so later mutation of the caller's buffer cannot corrupt the record.
    this.#writtenChunks.push(Buffer.from(data));
    return Promise.resolve();
  }

  writeRaw(byte: number): Promise<void> {
    if (!Number.isInteger(byte) || byte < 0 || byte > MAX_BYTE) {
      return Promise.reject(
        new SerialTransportError(
          'write-failed',
          `Invalid real-time byte ${String(byte)}; expected an integer in [0, 255]`,
          this.#path,
        ),
      );
    }
    return this.write(Buffer.from([byte & MAX_BYTE]));
  }

  /**
   * Script an inbound board response. Strings are encoded as UTF-8. If the port
   * is open the `data` event fires immediately; otherwise the chunk is queued
   * and flushed, in order, when {@link FakeTransport.open} succeeds.
   */
  pushIncoming(data: Buffer | string): void {
    const chunk = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
    if (this.#state === 'open') {
      this.emit('data', chunk);
    } else {
      this.#incomingQueue.push(chunk);
    }
  }

  /** All outbound bytes so far, concatenated in write order. */
  getWrittenBytes(): Buffer {
    return Buffer.concat(this.#writtenChunks);
  }

  /** Each outbound `write`/`writeRaw` call as its own buffer, in order. */
  getWrittenChunks(): Buffer[] {
    return this.#writtenChunks.map((chunk) => Buffer.from(chunk));
  }

  /**
   * Assert the EXACT outbound byte sequence. Numbers are single bytes (0-255),
   * strings are UTF-8 encoded, and buffers are taken verbatim; all are
   * concatenated and compared against the recorded output. On mismatch this
   * throws with a readable hex diff.
   */
  expectWritten(...expected: ExpectedWrite[]): void {
    const expectedBuffer = Buffer.concat(expected.map((item) => normalizeExpected(item)));
    const actualBuffer = this.getWrittenBytes();

    if (!actualBuffer.equals(expectedBuffer)) {
      throw new Error(
        `FakeTransport outbound byte mismatch on ${this.#path}:\n` +
          `  expected: ${toHex(expectedBuffer)}\n` +
          `  actual:   ${toHex(actualBuffer)}`,
      );
    }
  }

  /**
   * Script {@link FakeTransport.open} to fail. With no argument a typed
   * `open-failed` error is used; a custom {@link SerialTransportError} may be
   * supplied instead.
   */
  scriptOpenError(error?: SerialTransportError): void {
    this.#scriptedOpenError =
      error ??
      new SerialTransportError(
        'open-failed',
        `Failed to open fake serial port ${this.#path}`,
        this.#path,
      );
  }

  /**
   * Simulate a device-initiated close (e.g. an unplug). Emits a typed `close`
   * exactly once; a no-op if already closed.
   */
  scriptClose(): void {
    if (this.#state === 'closed') {
      return;
    }
    this.#state = 'closed';
    this.emit('close');
  }

  /**
   * Simulate an underlying device error. With no argument a typed `device-error`
   * is used. Guards on listener count so an unobserved error can never crash the
   * process, mirroring the real transport.
   */
  emitError(error?: SerialTransportError): void {
    const wrapped =
      error ??
      new SerialTransportError(
        'device-error',
        `Fake serial port error on ${this.#path}`,
        this.#path,
      );
    if (this.listenerCount('error') > 0) {
      this.emit('error', wrapped);
    }
  }

  /**
   * Reset all recorded output, queued input, scripted failures, and lifecycle
   * state back to a fresh, closed transport. Registered listeners are left
   * intact so a test can reuse its subscriptions across scenarios.
   */
  reset(): void {
    this.#state = 'closed';
    this.#writtenChunks = [];
    this.#incomingQueue = [];
    this.#scriptedOpenError = undefined;
  }
}

function normalizeExpected(item: ExpectedWrite): Buffer {
  if (typeof item === 'number') {
    if (!Number.isInteger(item) || item < 0 || item > MAX_BYTE) {
      throw new Error(
        `expectWritten received an invalid byte ${String(item)}; expected an integer in [0, 255]`,
      );
    }
    return Buffer.from([item]);
  }
  if (typeof item === 'string') {
    return Buffer.from(item);
  }
  return Buffer.from(item);
}

function toHex(buffer: Buffer): string {
  if (buffer.length === 0) {
    return '<empty>';
  }
  const parts: string[] = [];
  for (const byte of buffer) {
    parts.push(byte.toString(16).padStart(2, '0'));
  }
  return parts.join(' ');
}
