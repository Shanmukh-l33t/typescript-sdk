import type { JSONRPCMessage } from '../types/index';
import { JSONRPCMessageSchema } from '../types/index';
import { defaultParseJson } from './exactJson';

export const STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Buffers a continuous stdio stream into discrete JSON-RPC messages.
 */
export class ReadBuffer {
    private _buffer?: Buffer;
    private _maxBufferSize: number;
    private _parseJson?: (text: string) => unknown;

    constructor(options?: {
        /**
         * Maximum size of the read buffer in bytes. If a single message exceeds
         * this size the transport will emit an error and close.
         *
         * Defaults to 10 MB.
         */
        maxBufferSize?: number;
        /**
         * Custom JSON parser used to decode each message line instead of
         * `JSON.parse`. Use it to decode numbers exactly (e.g.
         * `parseExactJson`, or a `JSON.parse` reviver with `context.source`, or
         * a lossless-json parser) — plain `JSON.parse` rounds integer tokens
         * above `Number.MAX_SAFE_INTEGER` (issue #3150).
         */
        parseJson?: (text: string) => unknown;
    }) {
        this._maxBufferSize = options?.maxBufferSize ?? STDIO_DEFAULT_MAX_BUFFER_SIZE;
        this._parseJson = options?.parseJson;
    }

    append(chunk: Buffer): void {
        const newSize = (this._buffer?.length ?? 0) + chunk.length;
        if (newSize > this._maxBufferSize) {
            this.clear();
            throw new Error(`ReadBuffer exceeded maximum size of ${this._maxBufferSize} bytes`);
        }
        this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk;
    }

    readMessage(): JSONRPCMessage | null {
        while (this._buffer) {
            const index = this._buffer.indexOf('\n');
            if (index === -1) {
                return null;
            }

            const line = this._buffer.toString('utf8', 0, index).replace(/\r$/, '');
            this._buffer = this._buffer.subarray(index + 1);

            try {
                return deserializeMessage(line, { parseJson: this._parseJson });
            } catch (error) {
                // Skip non-JSON lines (e.g., debug output from hot-reload tools like
                // tsx or nodemon that write to stdout). Schema validation errors still
                // throw so malformed-but-valid-JSON messages surface via onerror.
                if (error instanceof SyntaxError) {
                    continue;
                }
                throw error;
            }
        }
        return null;
    }

    clear(): void {
        this._buffer = undefined;
    }
}

/**
 * Parses one JSON-RPC message line.
 *
 * @param options.parseJson Custom JSON parser used instead of `JSON.parse`
 * (e.g. `parseExactJson`, or a `JSON.parse` reviver with `context.source`, or
 * a lossless-json parser) so integers above `Number.MAX_SAFE_INTEGER` decode
 * exactly instead of being silently rounded (issue #3150). The parsed value
 * is what `JSONRPCMessageSchema` validates and what the application receives.
 */
export function deserializeMessage(line: string, options?: { parseJson?: (text: string) => unknown }): JSONRPCMessage {
    return JSONRPCMessageSchema.parse((options?.parseJson ?? defaultParseJson)(line));
}

/**
 * Serializes one JSON-RPC message line (newline-terminated).
 *
 * @param options.stringifyJson Custom JSON stringifier used instead of
 * `JSON.stringify` (e.g. `stringifyExactJson`, or a lossless-json encoder) so
 * exact values round-trip in requests (issue #3150).
 */
export function serializeMessage(message: JSONRPCMessage, options?: { stringifyJson?: (value: unknown) => string }): string {
    return (options?.stringifyJson ?? JSON.stringify)(message) + '\n';
}
