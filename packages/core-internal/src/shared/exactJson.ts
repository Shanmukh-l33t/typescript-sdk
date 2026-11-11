/**
 * Exact-number JSON parsing/stringifying for JSON-RPC message codecs.
 *
 * Plain `JSON.parse` silently rounds integer tokens above
 * `Number.MAX_SAFE_INTEGER`, so a server message like
 * `{"id": 9007199254740993}` reaches the application as `9007199254740992`
 * (issue #3150). The opt-in `parseJson`/`stringifyJson` hooks on the framing
 * helpers and the transports let applications decode and encode those values
 * exactly; this module provides a dependency-free implementation of both
 * hooks plus the warning-augmented default parser.
 */

/**
 * `parseJson` implementation that preserves integer tokens outside the
 * IEEE-754 safe range as `BigInt`.
 *
 * Uses the JSON.parse source-text access escape hatch (the reviver's
 * `context.source`, Node 22+ and current browsers): every decimal integer
 * token beyond `Number.MAX_SAFE_INTEGER` is revived as the exact `BigInt`
 * for its source text; safe integers stay plain numbers, and non-integer
 * numbers, strings, and exponent-notation tokens are left to `JSON.parse`.
 *
 * On engines without `context.source` the exact token is unrecoverable, so
 * values decode exactly as plain `JSON.parse` would (rounded) — the hook
 * never throws where plain parsing would have succeeded.
 *
 * Note that JSON-RPC `id` values are validated against the protocol schemas
 * *after* this hook runs: a numeric id outside the safe range becomes a
 * `BigInt` and is rejected loudly by the id schema rather than silently
 * round-tripped under a different value. Keep numeric ids within
 * `Number.MAX_SAFE_INTEGER` or use string ids.
 */
export function parseExactJson(text: string): unknown {
    return JSON.parse(text, ((_key: string, value: unknown, context?: { source?: string }): unknown => {
        const source = context?.source;
        if (typeof value === 'number' && source !== undefined && /^-?\d+$/.test(source) && !Number.isSafeInteger(value)) {
            return BigInt(source);
        }
        return value;
    }) as (this: unknown, key: string, value: unknown) => unknown);
}

/**
 * `stringifyJson` implementation that encodes `BigInt` values as raw JSON
 * number tokens, so exact integers decoded by {@link parseExactJson} (or
 * authored by the application) round-trip without being converted to
 * strings.
 *
 * Requires `JSON.rawJSON` (Node 22+ and current browsers). When it is
 * missing, serializing a `BigInt` throws with guidance instead of silently
 * emitting a different JSON type — the check is per-value, so payloads
 * without big integers stringify normally on every engine.
 */
export function stringifyExactJson(value: unknown): string {
    return JSON.stringify(value, (_key: string, v: unknown): unknown => {
        if (typeof v === 'bigint') {
            const rawJSON = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;
            if (!rawJSON) {
                throw new Error(
                    `stringifyExactJson: cannot serialize BigInt ${v.toString()} exactly — this engine has no JSON.rawJSON. ` +
                        'Pass a custom stringifyJson (e.g. a lossless-json encoder) or convert big integers to strings before sending.'
                );
            }
            return rawJSON(v.toString());
        }
        return v;
    });
}

/**
 * The default `JSON.parse` used for message decoding when no `parseJson`
 * hook is configured: identical to `JSON.parse`, but warns when a decoded
 * integer exceeds `Number.MAX_SAFE_INTEGER` and was therefore silently
 * rounded — turning lossy decoding into something the application can
 * detect and report (issue #3150).
 */
export function defaultParseJson(text: string): unknown {
    const value = JSON.parse(text);
    const rounded = firstUnsafeInteger(value);
    if (rounded !== undefined) {
        console.warn(
            `[mcp-sdk] decoded the integer ${rounded}, which exceeds Number.MAX_SAFE_INTEGER; ` +
                'JSON.parse rounded it and the exact token is unrecoverable. ' +
                "Pass a parseJson hook (e.g. the SDK's parseExactJson) to the transport or framing helper " +
                'to decode these values exactly (issue #3150).'
        );
    }
    return value;
}

/**
 * Depth-first search for the first integer-valued number outside the safe
 * range — the signature of a rounded integer token (every integer token
 * beyond `Number.MAX_SAFE_INTEGER` decodes to such a double).
 */
function firstUnsafeInteger(value: unknown): number | undefined {
    if (typeof value === 'number') {
        return Number.isInteger(value) && !Number.isSafeInteger(value) ? value : undefined;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = firstUnsafeInteger(item);
            if (found !== undefined) {
                return found;
            }
        }
        return undefined;
    }
    if (typeof value === 'object' && value !== null) {
        for (const item of Object.values(value)) {
            const found = firstUnsafeInteger(item);
            if (found !== undefined) {
                return found;
            }
        }
    }
    return undefined;
}
