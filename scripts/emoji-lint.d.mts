// SPDX-License-Identifier: Apache-2.0
export interface EmojiHit { ch: string; line: number; col: number; cp: string }
export function isForbidden(ch: string): boolean;
export function findForbidden(text: string): EmojiHit[];
