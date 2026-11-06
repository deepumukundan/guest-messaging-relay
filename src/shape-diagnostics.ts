/**
 * Temporary payload-shape diagnostics for Quo and WhatsApp.
 *
 * Delete this module and its call sites in src/index.ts after one or two
 * live messages per channel have been captured. Set SHAPE_DIAGNOSTICS to
 * false to stop the extra log line without removing the code.
 *
 * The log records field names and JSON types only. A few enum-like keys may
 * include a short token value. Message text, names, phone numbers, emails,
 * ids, URLs, and secrets are never written.
 */

/** Master switch. One place to turn the extra log line off. */
export const SHAPE_DIAGNOSTICS = true;

/**
 * Stop expanding objects and arrays at this depth.
 * Array levels count, so a WhatsApp `entry.changes.value.messages.text.body`
 * path still expands. Deeper nesting is replaced with `object` or `array`.
 */
export const SHAPE_MAX_DEPTH = 10;

/** UTF-8 byte cap for the `shape` value, including a truncation marker. */
export const SHAPE_MAX_BYTES = 6 * 1024;

/** Present on a shape node when depth, width, or bytes were cut. */
export const SHAPE_TRUNCATED = "<truncated>" as const;

const VALUE_KEYS = new Set([
  "apiVersion",
  "direction",
  "status",
  "type",
  "event",
  "object",
  "messaging_product",
  "field",
]);

const ENUM_VALUE = /^[A-Za-z0-9._-]+$/;
const E164_VALUE = /^\+\d{8,15}$/;
const ISO_VALUE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;

const encoder = new TextEncoder();

export interface ArrayShape {
  array: Shape[];
  length: number;
  "<truncated>"?: true;
}

export interface ObjectShape {
  [key: string]: Shape | true;
}

export type Shape = string | ArrayShape | ObjectShape;

/**
 * Redacted schema of a JSON value. Safe to call on any parsed body.
 * Never includes the original string values except the allowlisted tokens.
 */
export function payloadShape(value: unknown): Shape {
  return fit(describe(value, 0, null), SHAPE_MAX_BYTES);
}

/**
 * One diagnostic line after Quo or WhatsApp verification has succeeded.
 * Swallows every error so a diagnostics failure cannot change the response.
 */
export function emitPayloadShape(
  relay: string,
  source: "quo" | "whatsapp",
  body: Uint8Array,
  outcome: string | null,
  reason: string | null,
): void {
  if (!SHAPE_DIAGNOSTICS) {
    return;
  }
  try {
    console.log(
      JSON.stringify({
        relay,
        diag: "payload_shape",
        source,
        outcome,
        reason,
        shape: shapeFromBody(body),
      }),
    );
  } catch {
    // Diagnostics must never change the response.
  }
}

function shapeFromBody(body: Uint8Array): Shape {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
    return payloadShape(JSON.parse(text));
  } catch {
    return "unparsed";
  }
}

function describe(value: unknown, depth: number, key: string | null): Shape {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    if (depth >= SHAPE_MAX_DEPTH) {
      return value.length === 0 ? { array: [], length: 0 } : "array";
    }
    const node: ArrayShape = {
      array: value.slice(0, 2).map((item) => describe(item, depth + 1, null)),
      length: value.length,
    };
    if (value.slice(0, 2).some((item) => cappedContainer(item, depth + 1))) {
      node[SHAPE_TRUNCATED] = true;
    }
    return node;
  }
  if (typeof value === "object") {
    if (depth >= SHAPE_MAX_DEPTH) {
      return Object.keys(value as Record<string, unknown>).length === 0 ? {} : "object";
    }
    const out: ObjectShape = {};
    let truncated = false;
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = describe(child, depth + 1, childKey);
      if (cappedContainer(child, depth + 1)) {
        truncated = true;
      }
    }
    if (truncated) {
      out[SHAPE_TRUNCATED] = true;
    }
    return out;
  }
  if (typeof value === "string") {
    return describeString(key, value);
  }
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  return "unparsed";
}

/** True when this container is not expanded because the depth cap was hit. */
function cappedContainer(value: unknown, depth: number): boolean {
  if (depth < SHAPE_MAX_DEPTH || value === null || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Object.keys(value as Record<string, unknown>).length > 0;
}

function describeString(key: string | null, value: string): string {
  const allowed = key !== null && VALUE_KEYS.has(key);
  if (allowed && value.length <= 40 && ENUM_VALUE.test(value)) {
    return value;
  }
  if (allowed) {
    return "string";
  }
  if (E164_VALUE.test(value)) {
    return "e164";
  }
  if (ISO_VALUE.test(value)) {
    return "datetime";
  }
  return `string(len=${value.length})`;
}

function isArrayShape(value: Shape): value is ArrayShape {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as ArrayShape;
  return Array.isArray(record.array) && typeof record.length === "number";
}

function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function fit(node: Shape, budget: number): Shape {
  if (jsonBytes(node) <= budget) {
    return node;
  }
  if (typeof node === "string") {
    return jsonBytes("truncated") <= budget ? "truncated" : "string";
  }
  if (isArrayShape(node)) {
    return fitArray(node, budget);
  }
  return fitObject(node, budget);
}

function arrayElementRoom(kept: Shape[], length: number, budget: number): number {
  const probe: ArrayShape = { array: [...kept, ""], length, [SHAPE_TRUNCATED]: true };
  return budget - (jsonBytes(probe) - jsonBytes(""));
}

function fitArray(node: ArrayShape, budget: number): Shape {
  const kept: Shape[] = [];
  for (const element of node.array) {
    const next: ArrayShape = { array: [...kept, element], length: node.length, [SHAPE_TRUNCATED]: true };
    if (jsonBytes(next) <= budget) {
      kept.push(element);
      continue;
    }
    const room = arrayElementRoom(kept, node.length, budget);
    if (room >= 2) {
      const shrunk = fit(element, room);
      const withShrunk: ArrayShape = {
        array: [...kept, shrunk],
        length: node.length,
        [SHAPE_TRUNCATED]: true,
      };
      if (jsonBytes(withShrunk) <= budget && jsonBytes(shrunk) < jsonBytes(element)) {
        kept.push(shrunk);
      }
    }
    break;
  }
  const out: ArrayShape = { array: kept, length: node.length, [SHAPE_TRUNCATED]: true };
  if (jsonBytes(out) <= budget) {
    return out;
  }
  const empty: ArrayShape = { array: [], length: node.length, [SHAPE_TRUNCATED]: true };
  return jsonBytes(empty) <= budget ? empty : "truncated";
}

function fitObject(node: ObjectShape, budget: number): Shape {
  const keys = Object.keys(node).filter((key) => key !== SHAPE_TRUNCATED);
  const out: ObjectShape = {};
  let truncated = false;
  for (const key of keys) {
    const child = node[key];
    if (child === true) {
      continue;
    }
    const trial: ObjectShape = { ...out, [key]: child };
    if (jsonBytes(trial) <= budget) {
      out[key] = child;
      continue;
    }
    const room = valueRoom({ ...out, [SHAPE_TRUNCATED]: true }, key, budget);
    if (room >= 2) {
      const shrunk = fit(child, room);
      const shrunkTrial: ObjectShape = { ...out, [key]: shrunk };
      if (jsonBytes(shrunkTrial) <= budget && jsonBytes(shrunk) < jsonBytes(child)) {
        out[key] = shrunk;
        truncated = true;
        continue;
      }
    }
    truncated = true;
    break;
  }
  if (truncated || Object.keys(out).length < keys.length) {
    out[SHAPE_TRUNCATED] = true;
  }
  while (jsonBytes(out) > budget) {
    const real = Object.keys(out).filter((key) => key !== SHAPE_TRUNCATED);
    if (real.length === 0) {
      return "truncated";
    }
    delete out[real[real.length - 1]];
    out[SHAPE_TRUNCATED] = true;
  }
  return out;
}

/** Bytes left for a replacement of the empty-string probe at `key`. */
function valueRoom(partial: object, key: string, budget: number): number {
  const probe = { ...partial, [key]: "" };
  return budget - (jsonBytes(probe) - jsonBytes(""));
}
