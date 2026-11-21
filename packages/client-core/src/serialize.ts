// Lossless JSON codec for client state: Uint8Array, Map and Set survive a round trip.
import { b64, unb64 } from './encoding.ts';

export function encodeState(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val instanceof Uint8Array) return { $u8: b64(val) };
    if (val instanceof Map) return { $map: [...val.entries()] };
    if (val instanceof Set) return { $set: [...val.values()] };
    return val;
  });
}

export function decodeState<T>(s: string): T {
  return JSON.parse(s, (_k, val) => {
    if (val && typeof val === 'object') {
      if ('$u8' in val) return unb64(val.$u8);
      if ('$map' in val) return new Map(val.$map);
      if ('$set' in val) return new Set(val.$set);
    }
    return val;
  }) as T;
}
