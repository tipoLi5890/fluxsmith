// SPDX-License-Identifier: Apache-2.0
export interface VolatileHit { rule: string; line: number; excerpt: string }
export const VOLATILE_RULES: [string, RegExp][];
export function findVolatile(text: string, opts?: { skipRules?: string[] }): VolatileHit[];
export function manifestDescriptionLines(text: string): string;
export function frontMatter(md: string): string;
export function lintRepo(root?: string): string[];
