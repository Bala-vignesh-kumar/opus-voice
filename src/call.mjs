// One phone call, as a state machine.
//
// Events in, effects out. No network, no timers, no speaking — those belong to
// phone.mjs and index.mjs respectively. The reason this is a separate file
// rather than another few hundred lines of index.mjs is the same reason
// chunk.mjs is: splitting a stream into sentences is mechanism, deciding to
// speak is policy. Which state a call is in is mechanism too, and mechanism
// with this many corners deserves tests that do not need a telephone.
//
// The corner that matters is `consulting`. A call reaches a decision Falcon is
// not allowed to make — the restaurant offers eight when you asked for seven —
// and rather than guessing, it holds the line and asks you. That means a
// stranger is standing at a phone waiting for you to answer, which is why the
// hold has a deadline and why running out of it is a designed behaviour rather
// than a timeout error.

export const STATE = {
  IDLE: 'idle',
  DIALING: 'dialing',
  TALKING: 'talking',
  CONSULTING: 'consulting',
  WRAPPING: 'wrapping',
  ENDED: 'ended',
  FAILED: 'failed',
};

/** How long somebody may be left holding while you decide. */
export const DEFAULT_HOLD_MS = 20_000;

/** Backstop against an agent that will not shut up, in seconds. */
export const DEFAULT_MAX_SECONDS = 300;

// What the far end is told when you do not answer in time. Deliberately the
// demo's own behaviour: promise a call back, hang up politely, keep the
// objective so a second call can finish it. The alternative — guessing on your
// behalf — is the one thing this feature must never do.
export const CALL_BACK_INSTRUCTION =
  'I have not been able to check. Tell them you will call back shortly to '
  + 'confirm, thank them, and end the call. Do not agree to anything.';

/** States in which the call is still costing money and can still be acted on. */
const LIVE = new Set([STATE.DIALING, STATE.TALKING, STATE.CONSULTING, STATE.WRAPPING]);

export class Call {
  constructor({
    objective,
    number,
    holdMs = DEFAULT_HOLD_MS,
    maxSeconds = DEFAULT_MAX_SECONDS,
  }) {
    this.objective = objective;
    this.number = number;
    this.holdMs = holdMs;
    this.maxSeconds = maxSeconds;
    this.state = STATE.IDLE;
    this.transcript = [];
    /** The tool call left pending while you decide, or null. */
    this.pending = null;
    /** When the hold runs out. index.mjs owns the timer; this is only the time. */
    this.holdDeadline = null;
    /** Set once the call achieves what it was for. */
    this.outcome = '';
    this.connectedAt = null;
  }

  get live() {
    return LIVE.has(this.state);
  }

  /** True unless the call actually did the thing it was placed to do. */
  get unfinished() {
    return !this.outcome;
  }

  #to(state) {
    this.state = state;
    return { type: 'state', state };
  }

  dial(now) {
    if (this.state !== STATE.IDLE) {
      throw new Error(`a call is already ${this.state}`);
    }
    this.startedAt = now;
    return [this.#to(STATE.DIALING)];
  }

  connected(now) {
    if (this.state !== STATE.DIALING) return [];
    this.connectedAt = now;
    return [this.#to(STATE.TALKING)];
  }

  /** Something was said, by them or by us. Kept for the report. */
  heard(who, text) {
    if (!this.live || !text) return [];
    this.transcript.push({ who, text });
    return [];
  }

  /**
   * The agent has hit a decision it may not make. Hold the line and ask.
   *
   * The tool call is left pending on purpose: the provider is blocked on our
   * HTTP response, which is what keeps the far end on the line rather than
   * hearing dead air while Falcon talks to you in another room.
   */
  consult({ id, question }, now) {
    if (this.state !== STATE.TALKING) return [];
    this.pending = { id, question };
    this.holdDeadline = now + this.holdMs;
    return [this.#to(STATE.CONSULTING), { type: 'ask', id, question }];
  }

  /**
   * Your decision. Resolves the pending tool and the agent carries on talking.
   *
   * Answers that arrive when nothing was asked are dropped rather than sent:
   * anything you happen to say while a call is running would otherwise be
   * posted to the far end as an instruction.
   */
  answer(text, _now) {
    if (this.state !== STATE.CONSULTING || !this.pending) return [];
    const { id } = this.pending;
    this.pending = null;
    this.holdDeadline = null;
    return [{ type: 'resolve', id, answer: text }, this.#to(STATE.TALKING)];
  }

  /** You did not answer in time. Nobody is left holding for a Falcon that went quiet. */
  expireHold(_now) {
    if (this.state !== STATE.CONSULTING || !this.pending) return [];
    const { id } = this.pending;
    this.pending = null;
    this.holdDeadline = null;
    return [
      { type: 'resolve', id, answer: CALL_BACK_INSTRUCTION },
      this.#to(STATE.WRAPPING),
      { type: 'say', text: 'I left it open — I said we would call back to confirm.' },
    ];
  }

  /** The call achieved what it was placed for. */
  settled(outcome, _now) {
    if (!this.live) return [];
    this.outcome = outcome;
    return [];
  }

  /** The line closed, from either end. */
  remoteEnd(reason, _now) {
    if (!this.live) return [];
    const report = {
      type: 'report',
      outcome: this.outcome || reason,
      unfinished: this.unfinished,
      transcript: this.transcript,
    };
    return [this.#to(STATE.ENDED), report];
  }

  /** It never became a conversation: no answer, busy, a provider error. */
  failed(reason, _now) {
    if (!this.live) return [];
    return [
      this.#to(STATE.FAILED),
      { type: 'report', outcome: reason, unfinished: this.unfinished, transcript: this.transcript },
    ];
  }

  /** Has this call outstayed its cap? Guards against an agent burning credit. */
  overrun(now) {
    if (!this.connectedAt) return false;
    return now - this.connectedAt > this.maxSeconds * 1000;
  }
}
