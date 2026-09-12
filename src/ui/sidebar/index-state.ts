// SPDX-License-Identifier: Apache-2.0
import { create } from "zustand";

export interface IndexState { state: "building" | "ready" | "empty" | "error"; done: number; total: number }
interface Store { idx: IndexState | null; set(i: IndexState): void }
export const useIndexStore = create<Store>((set) => ({ idx: null, set(i) { set({ idx: i }); } }));
export function useEnvIndex(): IndexState | null { return useIndexStore((s) => s.idx); }
