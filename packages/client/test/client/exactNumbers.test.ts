/**
 * Exact-number JSON handling through the real client transports (issue #3150).
 *
 * Every client-side decode path parsed with plain `JSON.parse`, so integers
 * above `Number.MAX_SAFE_INTEGER` in server messages were silently rounded on
 * SSE events, JSON responses and stdio lines. These tests pin the opt-in
 * `parseJson`/`stringifyJson` hooks on the transport options, exercised through
 * the transport classes themselves (not by calling the framing helpers).
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import type { Mock } from 'vitest';

import { SSEClientTransport } from '../../src/client/sse';
import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp';

/** `9007199254740993` = 2^53 + 1: one above `Number.MAX_SAFE_INTEGER`. */
const BIG_INT_LINE = '{"jsonrpc":"2.0","id":1,"result":{"content":[],"structuredContent":{"id":9007199254740993}}}';

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

type BigResult = { result: { structuredContent: { id: unknown } } };

describe('StreamableHTTPClientTransport exact numbers (issue #3150)', () => {
    let transport: StreamableHTTPClientTransport;

    afterEach(async () => {
        await transport?.close().catch(() => {});
        vi.clearAllMocks();
    });

    test('parseJson is honored on the JSON response branch', async () => {
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            parseJson: parseKeepingBigInt
        });
        vi.spyOn(globalThis, 'fetch');

        // The mock offers both text() and json(): unmodified code takes the
        // json() path (plain JSON.parse inside -> rounded), the fixed code
        // takes text() and feeds it to the hook.
        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            text: () => Promise.resolve(BIG_INT_LINE),
            json: () => Promise.resolve(JSON.parse(BIG_INT_LINE))
        });

        const messageSpy = vi.fn();
        transport.onmessage = messageSpy;
        await transport.send({ jsonrpc: '2.0', id: 1, method: 'test', params: {} } as JSONRPCMessage);

        expect(messageSpy).toHaveBeenCalled();
        const received = messageSpy.mock.calls[0]![0] as BigResult;
        expect(String(received.result.structuredContent.id)).toBe('9007199254740993');
    });

    test('parseJson is honored on the SSE event branch', async () => {
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            parseJson: parseKeepingBigInt
        });
        vi.spyOn(globalThis, 'fetch');

        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${BIG_INT_LINE}\n\n`));
            }
        });
        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: stream
        });

        const messageSpy = vi.fn();
        transport.onmessage = messageSpy;
        await transport.send({ jsonrpc: '2.0', id: 1, method: 'test', params: {} } as JSONRPCMessage);
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(messageSpy).toHaveBeenCalled();
        const received = messageSpy.mock.calls[0]![0] as BigResult;
        expect(String(received.result.structuredContent.id)).toBe('9007199254740993');
    });

    test('stringifyJson is honored on the POST body so exact values round-trip in requests', async () => {
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            stringifyJson: stringifyKeepingBigInt
        });
        vi.spyOn(globalThis, 'fetch');

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 202,
            headers: new Headers()
        });

        await transport.send({
            jsonrpc: '2.0',
            id: 'req-1',
            method: 'tools/call',
            params: { name: 'echo', arguments: { id: 9007199254740993n } }
        } as unknown as JSONRPCMessage);

        const init = (globalThis.fetch as Mock).mock.calls[0]![1] as { body: string };
        expect(init.body).toContain('"id":9007199254740993');
    });
});

describe('SSEClientTransport exact numbers (issue #3150)', () => {
    let server: Server;
    let transport: SSEClientTransport;

    beforeEach(() => {
        // Undo the global fetch spy the StreamableHTTP describe installs —
        // this test must run over a real connection.
        vi.restoreAllMocks();
    });

    afterEach(async () => {
        await transport?.close().catch(() => {});
        server?.close();
    });

    test('parseJson is honored for SSE message events over a real connection', async () => {
        server = createServer((req, res) => {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive'
            });
            res.write('event: endpoint\n');
            res.write(`data: http://${req.headers.host}/messages\n\n`);
            res.write(`event: message\ndata: ${BIG_INT_LINE}\n\n`);
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as AddressInfo).port;

        transport = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`), {
            parseJson: parseKeepingBigInt
        });

        const messageSpy = vi.fn();
        transport.onmessage = messageSpy;
        await transport.start();
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(messageSpy).toHaveBeenCalled();
        const received = messageSpy.mock.calls[0]![0] as BigResult;
        expect(String(received.result.structuredContent.id)).toBe('9007199254740993');
    });
});
