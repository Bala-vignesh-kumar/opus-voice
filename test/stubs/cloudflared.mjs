#!/usr/bin/env node
// Stands in for `cloudflared tunnel --url ...`.
//
// STUB_TUNNEL_MODE: 'ok' prints a URL the way cloudflared does (banner on
// stderr, after a beat); 'silent' never prints one; 'die' exits immediately.
const mode = process.env.STUB_TUNNEL_MODE || 'ok';

if (mode === 'die') process.exit(3);

if (mode === 'ok') {
  setTimeout(() => {
    process.stderr.write('+---------------------------------------+\n');
    process.stderr.write('|  https://stub-tunnel.trycloudflare.com |\n');
    process.stderr.write('+---------------------------------------+\n');
  }, 20);
}

// Stay up until killed, as the real one does.
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
