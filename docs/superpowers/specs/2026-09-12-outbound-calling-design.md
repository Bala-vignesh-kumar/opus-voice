# Outbound calling — Falcon phones someone and reports back

Status: approved design, 2026-09-12.

## What this is

Falcon gains one capability: it can place a phone call on your behalf, talk to
whoever answers, ask you what to do when it hits a decision it is not allowed
to make, and tell you how it went.

The shape is taken from a demo where an assistant books a restaurant table: it
asks for 7pm, is offered 8pm, and — this is the interesting part — refuses to
accept on its own. It consults its owner first.

## What it is not

Not a call centre. One call at a time, outbound only, no inbound handling, no
call recording. It does not commit you to anything you did not say yes to.

## Decisions already made

These were settled in brainstorming and are not open in the plan.

**Rule 1 is amended, gateway-style.** Falcon's rule was that no audio leaves the
machine. A phone call breaks that by definition, and worse than the gateway did:
the gateway sends your words, a call sends *a third party's voice* — someone who
never agreed to anything. The amendment is the same bargain the gateway struck:
off unless configured, refuses to start without `RETELL_API_KEY` in the
environment, never reads the key from `config.json`, announces itself out loud
at startup, and is written down in CLAUDE.md.

**Falcon consults mid-call rather than hanging up.** The alternative — gather,
hang up, report, call back — is safer and is what the demo does. We chose the
harder one because it is a better experience, and we pay for it with a hold
budget (below).

**Falcon never commits without you.** Any booking, cancellation or promise needs
your spoken yes on that call.

**Disclosure is not configurable.** The agent identifies itself as an assistant
in its opening line, on every call. A test asserts the phrase is present in the
prompt sent to the provider.

**Provider is Retell.** Decided by one fact: Vapi's free number cannot place
outbound calls at all, which would block phase 2 below. The Falcon-side
interface is provider-shaped, so swapping is one file.

## Phases

There is no free tier anywhere that permits cold-calling a stranger. Twilio's
trial dials only numbers verified by SMS to that number; Vapi's free number
cannot dial out; Retell gives ~$10 of credit. So:

1. **Everything, against a stub.** Free, no account. The state machine, the
   consult protocol, the hold budget, the events, the window card, the tunnel
   lifecycle. This is the bulk of the work and none of it needs a phone.
2. **One real call to your own verified mobile.** You play the restaurant.
   Proves latency, barge-in and interruption — the things a stub cannot.
3. **A real business.** Needs a card. No code changes; only the number.

This document specifies phase 1. Phases 2 and 3 are configuration.

## Architecture

Driver/policy split, as the rest of the app does it.

| File | Job |
|---|---|
| `src/phone.mjs` | Retell's HTTP API and nothing else. Injectable `fetch`, `baseUrl`, `apiKey`. Knows no Falcon policy. |
| `src/call.mjs` | The call state machine. Events in, decisions out. No I/O, no timers, no network. |
| `src/tunnel.mjs` | `cloudflared` child process lifecycle. |
| `src/index.mjs` | All policy: whether to call, what to speak, what your answer means. |
| `src/bus.mjs` | Three new entry types so the window can draw a call. |
| `src/server.mjs` | One webhook route, live only while a call is. |

`call.mjs` holds mechanism, not policy: which state a call is in and what
transition an event implies. It sits on the same line as `chunk.mjs` —
sentence-splitting is mechanism, deciding to speak is policy.

## The state machine

```
        ┌──────────────────── hold expired ──────────┐
        │                                            v
idle -> dialing -> talking <-> consulting      wrapping -> ended
        │            │          (you decide)       ^
        │            └───────── objective met ─────┘
        └-> failed (no answer | voicemail | busy | provider error)
```

`consulting` is entered when the call agent invokes its one tool,
`ask_my_boss(question)`. While in it the far end hears a hold line, the tool
call is left pending, and Falcon runs an ordinary local turn: Piper asks, the
microphone listens. Your answer resolves the tool and the agent carries on with
the line still open.

Three properties keep that from being rude:

1. **A hold budget**, `phoneHoldMs`, default 20s. On expiry Falcon degrades to
   the demo's pattern — the agent says it will call back, hangs up, and the
   objective survives so a second call can finish the job. Nobody is left
   holding because you walked out of the room.
2. **`consulting` outranks the local mode machine.** A live call wakes Falcon
   and suspends `armSleep()`. Sleeping mid-consult would strand the call.
3. **One call at a time.** A second request while a call is live is refused out
   loud.

### Invariant: the hold budget sits under the provider's tool timeout

`phoneHoldMs` must be strictly less than the timeout configured on the Retell
custom function. If the provider gives up first, the agent improvises an answer
nobody sanctioned. This is asserted at call-creation time, not left to a
comment: `phone.mjs` sends the tool timeout it requires and refuses to dial if
config contradicts it.

## The consult sequence

```
you     "Falcon, book a table for three at seven"
        index.mjs: permitted? -> tunnel up (quick tunnels take ~3s) -> dial
call    agent: "Hi, this is Falcon, an assistant calling on behalf of <name>..."
them    "seven's full, we can do eight"
call    agent invokes ask_my_boss("7pm unavailable, 8pm offered for 3. Accept?")
        provider POSTs the tool call to the tunnel and blocks
        agent speaks its hold line while the tool is pending
falcon  -> consulting. Piper: "Seven is booked; they can do eight. Take it?"
you     "yes, book it"
        webhook response resolves the tool
call    agent: "eight works, please book it" ... confirms ... hangs up
falcon  -> wrapping -> ended. Piper reports the outcome.
```

The provider mechanism is a custom function with `speak_during_execution` set,
so the agent narrates the wait instead of going silent. Silence is what makes a
held human hang up.

## The new exposure

`src/server.mjs` binds loopback deliberately. A tool callback has to reach it
from the internet. Four constraints, all testable:

1. **The tunnel exists only during a call.** Started before dialing, killed on
   `ended`, on `failed`, and in `shutdown()`. No standing public surface.
2. **The route is registered only while a call is in flight.** It 404s
   otherwise, so a leaked URL is inert between calls.
3. **Three-way auth**: the session token, plus a per-call secret generated at
   dial time, plus a `call_id` matching the in-flight call. All three or denied.
4. **`cloudflared` is a child process**, so hard rules 4 and 5 apply verbatim:
   guarded writes, an `error` listener on the pipe, restart rather than die. A
   dead tunnel mid-call fails the call cleanly and never takes the app down.

## Failure handling

| Failure | Behaviour |
|---|---|
| No answer, busy, voicemail detected | `failed`, spoken report, objective kept |
| Far end hangs up mid-call | `ended` with what was learned so far |
| Hold budget expires | Agent promises a call back, hangs up, objective kept |
| Tunnel dies mid-call | Call is ended, reported honestly as a Falcon fault |
| Provider error or bad key | Refused at dial time, spoken, never silent |
| `phoneMaxSeconds` exceeded | Call is cut. Backstop against a stuck agent burning credit |

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `phone` | `false` | Master switch. Off means the capability does not exist |
| `phoneProvider` | `'retell'` | Which driver |
| `phoneHoldMs` | `20000` | How long a stranger may be held while you decide |
| `phoneMaxSeconds` | `300` | Hard cap on one call |
| `callerName` | `''` | Who Falcon says it is calling for. Required when `phone` is on |

`RETELL_API_KEY` comes from the environment only.

## Testing

All offline. `test/stubs/retell.mjs` is an HTTP server speaking the provider's
shape, scripted to refuse 7pm and offer 8pm, driving the real `phone.mjs` and
the real state machine.

- the happy path end to end: dial, offer, consult, answer, confirm, hang up
- hold expiry degrades to a call-back promise
- far end hangs up mid-consult
- a second call while one is live is refused
- tunnel death mid-call ends the call and does not kill the app
- the disclosure line is present in every outbound prompt
- `phoneHoldMs` >= the provider tool timeout refuses to dial
- a webhook missing any of the three credentials is denied
- the webhook 404s when no call is in flight

Hardware is never touched, per the existing convention.

## Out of scope

Inbound calls. Multiple concurrent calls. Call recording. Voicemail
transcription. Any commitment made without a spoken yes.
