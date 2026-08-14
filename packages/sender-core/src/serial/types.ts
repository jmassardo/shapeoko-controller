/**
 * Typed serial transport contract for `@shapeoko/sender-core`.
 *
 * This module defines the transport-agnostic surface that the sender core uses
 * to talk to a GRBL controller: the {@link SerialTransport} interface, the
 * strongly-typed event map, the typed error shape, and a small dependency
 * -injection seam ({@link SerialPortLike} / {@link SerialPortFactory}) so the
 * real `serialport` binding can be swapped for a deterministic test double
 * without hardware.
 *
 * Nothing here performs I/O; the concrete implementations live in
 * `transport.ts` (real port) and `fakeTransport.ts` (in-memory double).
 */

import { EventEmitter } from 'node:events';

/**
 * The discriminant for {@link SerialTransportError}. Every failure the transport
 * surfaces is one of these kinds, so callers branch on `.kind` rather than on
 * brittle, binding-specific `err.code` values.
 */
export type SerialErrorKind =
  'open-failed' | 'port-not-found' | 'closed' | 'write-failed' | 'device-error';

/**
 * The single typed error the transport ever rejects or emits. The underlying
 * `serialport` binding rejects with plain, untyped `Error`s (and, for a missing
 * path, an `Error` whose `.code` is `undefined`); this class wraps every such
 * failure so callers get a stable, discriminated shape.
 */
export class SerialTransportError extends Error {
  override readonly name = 'SerialTransportError';

  constructor(
    readonly kind: SerialErrorKind,
    message: string,
    readonly path: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * The typed events a {@link SerialTransport} emits. Each entry is the tuple of
 * arguments passed to listeners for that event.
 *
 * Declared as a type alias (not an interface) so it satisfies the
 * `Record<string, unknown[]>` constraint on {@link TypedEventEmitter}.
 */
export type SerialTransportEventMap = {
  /** A chunk of bytes received from the device. */
  data: [chunk: Buffer];
  /** The port finished opening successfully. */
  open: [];
  /** The port closed — either via {@link SerialTransport.close} or a disconnect. */
  close: [];
  /** A normalized transport error (never a raw binding error). */
  error: [error: SerialTransportError];
};

/**
 * A zero-dependency typed overlay over Node's {@link EventEmitter}. It keeps the
 * full runtime behavior of `EventEmitter` while constraining event names and
 * listener signatures to a supplied event map — no third-party typed-emitter
 * package (and therefore no extra supply-chain surface).
 */
export class TypedEventEmitter<TEventMap extends Record<string, unknown[]>> extends EventEmitter {
  override on<K extends keyof TEventMap & string>(
    event: K,
    listener: (...args: TEventMap[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override once<K extends keyof TEventMap & string>(
    event: K,
    listener: (...args: TEventMap[K]) => void,
  ): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  override off<K extends keyof TEventMap & string>(
    event: K,
    listener: (...args: TEventMap[K]) => void,
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  override addListener<K extends keyof TEventMap & string>(
    event: K,
    listener: (...args: TEventMap[K]) => void,
  ): this {
    return super.addListener(event, listener as (...args: unknown[]) => void);
  }

  override removeListener<K extends keyof TEventMap & string>(
    event: K,
    listener: (...args: TEventMap[K]) => void,
  ): this {
    return super.removeListener(event, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof TEventMap & string>(event: K, ...args: TEventMap[K]): boolean {
    return super.emit(event, ...args);
  }

  override listenerCount<K extends keyof TEventMap & string>(event: K): number {
    return super.listenerCount(event);
  }
}

/**
 * The transport-agnostic contract the sender core consumes. Implemented by both
 * {@link SerialPortTransport} (real hardware) and `FakeTransport` (tests).
 */
export interface SerialTransport {
  /** Open the port. Rejects with a {@link SerialTransportError} on failure. */
  open(): Promise<void>;
  /** Close the port. Idempotent — closing an already-closed port resolves. */
  close(): Promise<void>;
  /** Forward `data` to the device byte-for-byte, with no newline appended. */
  write(data: Buffer): Promise<void>;
  /** Write exactly one real-time command byte (0-255), with no newline. */
  writeRaw(byte: number): Promise<void>;

  on<K extends keyof SerialTransportEventMap & string>(
    event: K,
    listener: (...args: SerialTransportEventMap[K]) => void,
  ): this;
  once<K extends keyof SerialTransportEventMap & string>(
    event: K,
    listener: (...args: SerialTransportEventMap[K]) => void,
  ): this;
  off<K extends keyof SerialTransportEventMap & string>(
    event: K,
    listener: (...args: SerialTransportEventMap[K]) => void,
  ): this;
}

/**
 * The exact options {@link SerialPortTransport} hands to the port factory. These
 * mirror the GRBL wire contract (115200 8-N-1, no flow control) and are asserted
 * verbatim by the transport tests.
 */
export interface SerialPortOpenOptions {
  path: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
  stopBits: 1 | 1.5 | 2;
  rtscts: boolean;
  xon: boolean;
  xoff: boolean;
  xany: boolean;
  autoOpen: boolean;
}

/**
 * The minimal slice of the `serialport` `SerialPort` surface the transport
 * actually uses. Keeping it thin is what makes the dependency-injection test
 * seam type-checked, synchronous, and hardware-free.
 */
export interface SerialPortLike {
  readonly isOpen: boolean;
  open(callback: (error: Error | null) => void): void;
  write(data: Buffer, callback: (error: Error | null | undefined) => void): boolean;
  close(callback: (error: Error | null) => void): void;
  on(event: string, listener: (...args: unknown[]) => void): this;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
}

/**
 * Constructs a {@link SerialPortLike} from open options. The production factory
 * builds a real `serialport` `SerialPort`; tests inject a deterministic double.
 */
export type SerialPortFactory = (options: SerialPortOpenOptions) => SerialPortLike;
