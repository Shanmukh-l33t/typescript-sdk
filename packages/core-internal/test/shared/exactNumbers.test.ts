/**
 * Exact-number JSON handling for JSON-RPC messages (issue #3150).
 *
 * The SDK decodes every message with plain `JSON.parse`, which silently rounds
 * integer tokens above `Number.MAX_SAFE_INTEGER`. These tests pin the opt-in
 * `parseJson`/`stringifyJson` hooks on `deserializeMessage`, `serializeMessage`
 * and `ReadBuffer`, plus the built-in `parseExactJson`/`stringifyExactJson`
 * helpers and the default-parser rounding warning.
 */
import { parseExactJson, stringifyExactJson } from '../../src/shared/exactJson';
import { deserializeMessage, ReadBuffer, serializeMessage } from '../../src/shared/stdio';
import type { JSONRPCMessage } from '../../src/types/index';

/** `9007199254740993` = 2^53 + 1: one above `Number.MAX_SAFE_INTEGER`. */
const BIG_INT_LINE = '{"jsonrpc":"2.0","id":1,"result":{"content":[],"structuredContent":{"id":9007199254740993}}}';

/**
 * A consumer-supplied `parseJson` hook built on the JSON.parse source-text
 * access escape hatch (`reviver` third argument, `context.source` — Node 22+
 * and current browsers). Kept inline — not the SDK helper — so these tests
 * exercise the option plumbing with an arbitrary user parser.
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

describe('deserializeMessage parseJson hook (issue #3150)', () => {
    test('a parseJson hook preserves integers above Number.MAX_SAFE_INTEGER', () => {
        const message = deserializeMessage(BIG_INT_LINE, { parseJson: parseKeepingBigInt }) as unknown as BigResult;
        expect(String(message.result.structuredContent.id)).toBe('9007199254740993');
    });

    test('the hook result is what the schema validates and the application receives', () => {
        // The hook must run before JSONRPCMessageSchema.parse: the decoded
        // value (BigInt here) is what surfaces on the message.
        const message = deserializeMessage(BIG_INT_LINE, { parseJson: parseExactJson }) as unknown as BigResult;
        expect(message.result.structuredContent.id).toBe(9007199254740993n);
    });

    test('a parseJson hook is honored for safe integers too (the hook owns all parsing)', () => {
        const asStrings = (text: string): unknown => JSON.parse(text, (_key, value) => (typeof value === 'number' ? `n:${value}` : value));
        const message = deserializeMessage('{"jsonrpc":"2.0","id":1,"result":{"x":42}}', { parseJson: asStrings }) as unknown as {
            result: { x: unknown };
        };
        expect(message.result.x).toBe('n:42');
    });

    test('without a hook the default parser still round-trips safe integers unchanged', () => {
        const message = deserializeMessage('{"jsonrpc":"2.0","id":7,"result":{"structuredContent":{"id":123}}}');
        expect(message).toEqual({ jsonrpc: '2.0', id: 7, result: { structuredContent: { id: 123 } } });
    });

    test('a numeric id above the safe range is rejected loudly, never coerced to a string id', () => {
        // media-ctrl's point: the reviver must not change the id type — a
        // schema rejection is loud corruption control, a string id is silent
        // protocol corruption. The SDK documents the hook as opt-in exactly
        // for this trade-off; ids must stay within the safe range.
        const line = '{"jsonrpc":"2.0","id":9007199254740993,"result":{}}';
        expect(() => deserializeMessage(line, { parseJson: parseExactJson })).toThrow();
    });

    test('the same message with a safe id parses to a plain number id', () => {
        const ok = deserializeMessage('{"jsonrpc":"2.0","id":9007199254740991,"result":{}}') as unknown as { id: unknown };
        expect(ok.id).toBe(9007199254740991);
    });
});

describe('ReadBuffer parseJson hook', () => {
    test('ReadBuffer forwards its parseJson option to message parsing', () => {
        const readBuffer = new ReadBuffer({ parseJson: parseKeepingBigInt });
        readBuffer.append(Buffer.from(BIG_INT_LINE + '\n'));
        const message = readBuffer.readMessage() as unknown as BigResult;
        expect(String(message.result.structuredContent.id)).toBe('9007199254740993');
    });
});

describe('serializeMessage stringifyJson hook (issue #3150 round-trip)', () => {
    const exactMessage = {
        jsonrpc: '2.0',
        id: 1,
        result: { content: [], structuredContent: { id: 9007199254740993n } }
    } as unknown as JSONRPCMessage;

    test('a stringifyJson hook emits the exact integer token', () => {
        const text = serializeMessage(exactMessage, { stringifyJson: stringifyKeepingBigInt });
        expect(text).toContain('"id":9007199254740993');
    });

    test('exact values round-trip: decode -> encode preserves the original token', () => {
        const decoded = deserializeMessage(BIG_INT_LINE, { parseJson: parseExactJson });
        const reEncoded = serializeMessage(decoded, { stringifyJson: stringifyExactJson });
        expect(reEncoded).toContain('"id":9007199254740993');
        expect(JSON.parse(reEncoded)).toEqual(JSON.parse(BIG_INT_LINE));
        // ...and re-decoding gives back the same BigInt.
        const reDecoded = deserializeMessage(reEncoded, { parseJson: parseExactJson }) as unknown as BigResult;
        expect(reDecoded.result.structuredContent.id).toBe(9007199254740993n);
    });

    test('framing is unchanged: the hook output is still newline-terminated', () => {
        const text = serializeMessage({ jsonrpc: '2.0', method: 'ping' }, { stringifyJson: () => '{}' });
        expect(text).toBe('{}\n');
    });
});

describe('parseExactJson / stringifyExactJson built-ins', () => {
    test('integer tokens above the safe range become BigInt', () => {
        expect(parseExactJson('{"id":9007199254740993}')).toEqual({ id: 9007199254740993n });
        expect(parseExactJson('{"id":-9007199254740993}')).toEqual({ id: -9007199254740993n });
    });

    test('safe integers stay plain numbers', () => {
        expect(parseExactJson('{"id":9007199254740991}')).toEqual({ id: 9007199254740991 });
        expect(parseExactJson('{"id":0,"n":-1,"m":42}')).toEqual({ id: 0, n: -1, m: 42 });
    });

    test('non-integer numbers and digit strings are left alone', () => {
        expect(parseExactJson('{"f":1.5,"e":1e3,"s":"9007199254740993"}')).toEqual({
            f: 1.5,
            e: 1000,
            s: '9007199254740993'
        });
    });

    test('BigInts survive nested arrays and objects', () => {
        expect(parseExactJson('{"a":[[9007199254740993]],"o":{"deep":{"v":18446744073709551616}}}')).toEqual({
            a: [[9007199254740993n]],
            o: { deep: { v: 18446744073709551616n } }
        });
    });

    test('stringifyExactJson emits BigInt as a raw JSON number token', () => {
        expect(stringifyExactJson({ id: 9007199254740993n })).toBe('{"id":9007199254740993}');
    });

    test('stringifyExactJson round-trips through parseExactJson', () => {
        const value = { big: 9007199254740993n, nested: [{ bigger: -18446744073709551616n }], safe: 7, str: 'x' };
        expect(parseExactJson(stringifyExactJson(value))).toEqual(value);
    });
});

describe('default parser rounding warning (issue #3150)', () => {
    test('deserializeMessage warns when the default parse rounds an oversized integer', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            deserializeMessage(BIG_INT_LINE);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('MAX_SAFE_INTEGER'));
        } finally {
            warn.mockRestore();
        }
    });

    test('no warning for messages within the safe range', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            deserializeMessage('{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"id":9007199254740991}}}');
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    test('no warning when a parseJson hook is supplied (the hook owns exactness)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            deserializeMessage(BIG_INT_LINE, { parseJson: parseExactJson });
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });
});
