/**
 * Exact-number JSON handling on the server-side stdio transport (issue #3150).
 *
 * `deserializeMessage`/`ReadBuffer` serve the server as well as the client, so
 * the parseJson/stringifyJson hooks give servers exact incoming numbers (the
 * mirror of the reported bug: tool arguments carrying large integer ids).
 */
import { PassThrough } from 'node:stream';

import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';

import { StdioServerTransport } from '../../src/server/stdio';

/** `9007199254740993` = 2^53 + 1: one above `Number.MAX_SAFE_INTEGER`. */
const BIG_INT_LINE = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"id":9007199254740993}}}';

/**
 * A consumer-supplied `parseJson` hook built on the JSON.parse source-text
 * access escape hatch (`context.source`, Node 22+). Kept inline — not the SDK
 * helper — so these tests exercise the transport option with an arbitrary
 * user parser.
 */
const parseKeepingBigInt = (text: string): unknown =>
    (JSON.parse as (t: string, r: (key: string, value: unknown, context?: { source?: string }) => unknown) => unknown)(
        text,
        (_key, value, context) => {
            const source = context?.source;
            return typeof value === 'number' && source !== undefined && /^-?\d+$/.test(source) && !Number.isSafeInteger(value)
                ? BigInt(source)
                : value;
        }
    );

/** Consumer-supplied `stringifyJson` hook using `JSON.rawJSON` (Node 22+). */
const stringifyKeepingBigInt = (value: unknown): string =>
    JSON.stringify(value, (_key, v: unknown) => {
        if (typeof v === 'bigint') {
            return (JSON as unknown as { rawJSON: (text: string) => unknown }).rawJSON(v.toString());
        }
        return v;
    });

describe('StdioServerTransport exact numbers (issue #3150)', () => {
    test('parseJson is honored so tool arguments keep their exact integers', async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const transport = new StdioServerTransport(stdin, stdout, { parseJson: parseKeepingBigInt });

        const messageSpy = vi.fn();
        transport.onmessage = messageSpy;
        await transport.start();

        stdin.write(BIG_INT_LINE + '\n');
        await new Promise(resolve => setImmediate(resolve));

        expect(messageSpy).toHaveBeenCalled();
        const received = messageSpy.mock.calls[0]![0] as { params: { arguments: { id: unknown } } };
        expect(String(received.params.arguments.id)).toBe('9007199254740993');
        await transport.close();
    });

    test('stringifyJson is honored so exact values round-trip in responses', async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const written: string[] = [];
        stdout.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));

        const transport = new StdioServerTransport(stdin, stdout, { stringifyJson: stringifyKeepingBigInt });
        await transport.start();

        await transport.send({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [], structuredContent: { id: 9007199254740993n } }
        } as unknown as JSONRPCMessage);

        expect(written.join('')).toContain('"id":9007199254740993');
        await transport.close();
    });
});
