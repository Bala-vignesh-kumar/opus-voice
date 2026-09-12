// Stands in for the call provider, scripted as the restaurant in the demo:
// asked for seven, it offers eight and waits to be told what to do.
//
// It speaks the shape phone.mjs sends and calls back the way the real consult
// tool does — POST the question, block on the reply, act on it. That makes it
// the only test that drives the whole path at once: the driver, the webhook
// route, the state machine and the hold.

import http from 'node:http';

export function startProvider({ delayMs = 10 } = {}) {
  /** Everything the "agent" did, for the test to assert on. */
  const log = [];
  let answer = null;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const parsed = body ? JSON.parse(body) : {};

      if (req.url.endsWith('/create-phone-call')) {
        log.push({ event: 'dialed', to: parsed.to_number, prompt: JSON.stringify(parsed) });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ call_id: 'call_stub_1' }));

        // The conversation, a beat later: seven is full, eight is free, and the
        // agent is not allowed to accept that on its own.
        const tool = parsed.agent.response_engine.tools.find((t) => t.name === 'ask_my_boss');
        setTimeout(async () => {
          log.push({ event: 'asked' });
          try {
            const reply = await fetch(tool.url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                call_id: 'call_stub_1',
                metadata: parsed.metadata,
                args: { question: 'Seven is fully booked. They can do eight. Accept?' },
              }),
            });
            answer = (await reply.json()).response;
            log.push({ event: 'told', answer });
          } catch (err) {
            // The real provider survives a webhook it cannot reach; so does
            // this one, or a test that ends mid-consult fails the next one.
            log.push({ event: 'unreachable', message: err.message });
          }
        }, delayMs);
        return;
      }

      if (req.url.includes('/end-call/')) {
        log.push({ event: 'hungup' });
        res.writeHead(204).end();
        return;
      }

      res.writeHead(404).end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        log,
        get answer() { return answer; },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
