// SPDX-License-Identifier: Apache-2.0
export function parseArgs(argv: string[], defaults?: Record<string, string | boolean>): Record<string, string | boolean>;
export function projectKey(rootUuid: string, rootPath: string): string;
export function ercCounts(report: unknown, allowedTypes?: string[]): { errors: number; warnings: number; allowed: number; by_type: Record<string, number> };
export function runScore(match: { ok?: boolean; score?: number } | null | undefined): number;
export function quantile(values: number[], q: number): number;
export const SUBSETS: Record<string, string[]>;
export interface GoldenRun { task: string; run?: number; project?: string; ok: boolean; score: number; decision_cards?: number; hard_stops?: number; timed_out?: boolean; skipped_steps?: number; erc_errors?: number | null; erc_warnings?: number | null; tokens?: number; cost_usd?: number; cache_hit_ratio?: number; duration_s?: number; problems?: string[] }
export interface GoldenTask { score: number; ok: number; runs: number; pass: number; pass_rate: number; zero: boolean; weight: number; decision_cards: number; decision_cards_median: number; decision_cards_p90: number; hard_stops: number; timeouts: number; skipped_steps: number; erc_errors: number; erc_warnings: number; tokens: number; cost_usd: number; cache_hit_ratio: number; duration_s: number; problems: string[] }
export interface GoldenAggregate { per_task: Record<string, GoldenTask>; weighted: number; weighted_pass_rate: number; decision_cards_median: number; decision_cards_p90: number; hard_stops: number; zero_tasks: string[] }
export function aggregate(runs: GoldenRun[], weights?: Record<string, number>): GoldenAggregate;
export function summaryMarkdown(result: { recorded_at: string; model_id?: string | null; weighted: number; cost_usd: number; per_task: Record<string, GoldenTask>; weighted_pass_rate?: number; decision_cards_median?: number; decision_cards_p90?: number; hard_stops?: number; zero_tasks?: string[]; timed_out?: { task: string; run: number; project: string }[] }): string;
export function splitTaskMessages(text: string): string[];
export function copyFixture(fixtureDir: string, dir: string): { root: string; project: string; root_uuid: string; fixture_uuid: string } | null;
export interface ExpectedChange { ref: string; field: string; before?: string; after?: string }
export interface ReportedChange { reference: string; field: string; before: string; after: string; sheet?: string; turn?: number }
export function turnChanges(projectDir: string): ReportedChange[];
export function changedProblems(expectedChanged: ExpectedChange[] | undefined, changed: ReportedChange[]): string[];
export function lineDiff(a: string[], b: string[]): { removed: string[]; added: string[] };
export function untouchedLinesProblems(fixtureText: string, outputText: string, expectedChanged: ExpectedChange[] | undefined, uuids?: { output_uuid?: string; fixture_uuid?: string }): string[];
export function editContractProblems(expected: { changed?: ExpectedChange[]; untouched_lines?: boolean } | null, projectDir: string, created: { root_uuid?: string; fixture_uuid?: string } | null, fixtureDir?: string): string[];
