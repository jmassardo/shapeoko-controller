/**
 * Real serial transport backed by the `serialport` library.
 *
 * {@link SerialPortTransport} opens a physical GRBL controller at 115200 8-N-1
 * with no flow control, forwards bytes without mutation, writes single real-time
 * command bytes verbatim, and normalizes every underlying disconnect/error into
 * a typed event so an unplugged device can never crash the process (a DoS vector
 * for a CNC controller).
 *
 * The concrete `serialport` binding is reached only through an injectable
 * {@link SerialPortFactory}, which keeps the class fully unit-testable without
 * hardware and avoids brittle module-global mocking under ESM NodeNext.
 */

import { SerialPort } from 'serialport';

import {
  SerialTransportError,
  TypedEventEmitter,
  type SerialPortFactory,
  type SerialPortLike,
  type SerialPortOpenOptions,
  type SerialTransport,
  type SerialTransportEventMap,
} from './types.js';

/** Bytes below this cap are valid single real-time command bytes. */
const MAX_BYTE = 0xff;

/**
 * Production {@link SerialPortFactory}: constructs a real `serialport` port with
 * `autoOpen: false` so open failures surface through the `open()` promise rather
 * than an out-of-band `error` event. The port path is passed as a plain binding
 * argument — never through a shell — so there is no command-injection surface.
 */
export const defaultSerialPortFactory: SerialPortFactory = (
  options: SerialPortOpenOptions,
): SerialPortLike => new SerialPort(options);

type PortListener = (...args: unknown[]) => void;

/**
 * Typed serial transport over a real (or injected) serial port.
 */
export class SerialPortTransport
  extends TypedEventEmitter<SerialTransportEventMap>
  implements SerialTransport
{
  readonly #path: string;
  readonly #factory: SerialPortFactory;

  #port: SerialPortLike | undefined;
  #state: 'closed' | 'open' = 'closed';

  #onData: PortListener | undefined;
  #onClose: PortListener | undefined;
  #onError: PortListener | undefined;

  constructor(path: string, factory: SerialPortFactory = defaultSerialPortFactory) {
    super();
    this.#path = path;
    this.#factory = factory;
  }

  /** The configured port path. */
  get path(): string {
    return this.#path;
  }

  /** Whether the transport currently considers the port open. */
  get isOpen(): boolean {
    return this.#state === 'open';
  }

  open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.#state === 'open') {
        resolve();
        return;
      }

      const options: SerialPortOpenOptions = {
        path: this.#path,
        baudRate: 115200,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        rtscts: false,
        xon: false,
        xoff: false,
        xany: false,
        autoOpen: false,
      };

      let port: SerialPortLike;
      try {
        port = this.#factory(options);
      } catch (error) {
        reject(
          new SerialTransportError(
            'open-failed',
            `Failed to construct serial port for ${this.#path}: ${describe(error)}`,
            this.#path,
            error,
          ),
        );
        return;
      }

      port.open((error) => {
        if (error) {
          // The binding rejects a missing path with a plain, untyped Error whose
          // `.code` is undefined and emits NO open/error event. Wrap it; never
          // branch on `error.code`.
          reject(
            new SerialTransportError(
              'open-failed',
              `Failed to open serial port ${this.#path}: ${error.message}`,
              this.#path,
              error,
            ),
          );
          return;
        }

        this.#port = port;
        this.#state = 'open';
        this.#attachListeners(port);
        this.emit('open');
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      const port = this.#port;
      if (this.#state === 'closed' || port === undefined) {
        resolve();
        return;
      }

      port.close(() => {
        // Errors surfaced while closing are normalized through the port's own
        // `error`/`close` events; the close() contract is idempotent and never
        // rejects, so we simply resolve once the binding acknowledges.
        this.#handleClose();
        resolve();
      });
    });
  }

  write(data: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const port = this.#port;
      if (this.#state !== 'open' || port === undefined) {
        reject(
          new SerialTransportError(
            'closed',
            `Cannot write to serial port ${this.#path}: transport is not open`,
            this.#path,
          ),
        );
        return;
      }

      port.write(data, (error) => {
        if (error) {
          reject(
            new SerialTransportError(
              'write-failed',
              `Failed to write to serial port ${this.#path}: ${error.message}`,
              this.#path,
              error,
            ),
          );
          return;
        }
        resolve();
      });
    });
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

  #attachListeners(port: SerialPortLike): void {
    const onData: PortListener = (...args) => {
      const chunk = args[0];
      if (Buffer.isBuffer(chunk)) {
        this.emit('data', chunk);
      }
    };
    const onClose: PortListener = () => {
      this.#handleClose();
    };
    const onError: PortListener = (...args) => {
      const raw = args[0];
      this.#handleError(raw instanceof Error ? raw : new Error(describe(raw)));
    };

    this.#onData = onData;
    this.#onClose = onClose;
    this.#onError = onError;

    port.on('data', onData);
    port.on('close', onClose);
    port.on('error', onError);
  }

  #detachListeners(): void {
    const port = this.#port;
    if (port === undefined) {
      return;
    }
    if (this.#onData) {
      port.removeListener('data', this.#onData);
    }
    if (this.#onClose) {
      port.removeListener('close', this.#onClose);
    }
    if (this.#onError) {
      port.removeListener('error', this.#onError);
    }
    this.#onData = undefined;
    this.#onClose = undefined;
    this.#onError = undefined;
  }

  #handleClose(): void {
    if (this.#state === 'closed') {
      // Idempotent: a normal close() and a device-initiated close must not
      // double-emit, and listeners must be torn down exactly once.
      return;
    }
    this.#state = 'closed';
    this.#detachListeners();
    this.#port = undefined;
    this.emit('close');
  }

  #handleError(error: Error): void {
    const wrapped =
      error instanceof SerialTransportError
        ? error
        : new SerialTransportError(
            'device-error',
            `Serial port error on ${this.#path}: ${error.message}`,
            this.#path,
            error,
          );

    // Node's EventEmitter throws if an 'error' event is emitted with no
    // listeners. Emitting from a binding callback would then escape as an
    // uncaughtException and crash the controller, so guard on listener count.
    if (this.listenerCount('error') > 0) {
      this.emit('error', wrapped);
    }
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
}
