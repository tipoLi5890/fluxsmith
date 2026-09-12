// SPDX-License-Identifier: Apache-2.0
// Cards a tool waits on: the Lead emits the card, then registers the resolver; an answer that arrives in
// between (an automated answerer reacts to the card event within the same tick) must not be lost.

export interface CardAnswer { action_id: string; free_text?: string; consent_event_id?: string; grant?: string }

export interface CardWaiter {
  /** Wait for the answer to `cardId`; resolves at once when the answer already arrived. */
  show(cardId: string): Promise<CardAnswer>;
  /** Deliver an answer: resolves the waiter, or keeps it for a `show` that has not registered yet. */
  answer(cardId: string, r: CardAnswer): boolean;
  /** Forget a card (abort, dismissal): a late answer to it is dropped. */
  dismiss(cardId: string): void;
  has(cardId: string): boolean;
}

export function createCardWaiter(): CardWaiter {
  const pending = new Map<string, (r: CardAnswer) => void>();
  const early = new Map<string, CardAnswer>();
  return {
    show: (cardId) => new Promise<CardAnswer>((resolve) => {
      const e = early.get(cardId);
      if (e) { early.delete(cardId); resolve(e); return; }
      pending.set(cardId, resolve);
    }),
    answer: (cardId, r) => {
      const resolver = pending.get(cardId);
      if (resolver) { pending.delete(cardId); resolver(r); return true; }
      early.set(cardId, r);
      return false;
    },
    dismiss: (cardId) => { pending.delete(cardId); early.delete(cardId); },
    has: (cardId) => pending.has(cardId),
  };
}
