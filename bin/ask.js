#!/usr/bin/env node
'use strict';

// Terminal harness for POST /api/:state/ask — chat with the lake assistant
// against a local (or any) server without the mobile app.
//
//   node bin/ask.js [state] [--base http://localhost:3100] [--q "one-shot question"]
//
// REPL commands:  /new  (reset conversation)   /tool <name> <json>  (run a tool
// directly, dev servers only)   /prompt (print the state's system prompt)
// /state <xx>   /quit
//
// Prints each answer with [[id|Name]] markers rendered as "Name (id)", the
// lake cards the server attached, and a usage/cost line. Cost is an ESTIMATE
// from list prices below — the console bill is authoritative.

const readline = require('readline');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
let state = args.find(a => /^[a-z]{2}$/.test(a)) || 'mn';
const base = (opt('--base', process.env.ASK_BASE || 'http://localhost:3100')).replace(/\/$/, '');
const oneShot = opt('--q', null);
const userId = process.env.ASK_USER_ID || `ask-cli-${crypto.createHash('sha1').update(require('os').hostname()).digest('hex').slice(0, 12)}`;

// $/MTok list prices (2026-06 cache): [input, output, cache read, cache write]
const PRICES = {
  'claude-opus-5': [5, 25, 0.5, 6.25],
  'claude-opus-4-8': [5, 25, 0.5, 6.25],
  'claude-sonnet-5': [2, 10, 0.2, 2.5],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25],
  'claude-fable-5-1': [10, 50, 0.25, 12.5],
};
function estCost(u) {
  const key = Object.keys(PRICES).find(k => (u.model || '').startsWith(k));
  if (!key) return null;
  const [pi, po, pr, pw] = PRICES[key];
  return ((u.input_tokens || 0) * pi + (u.output_tokens || 0) * po
    + (u.cache_read_input_tokens || 0) * pr + (u.cache_creation_input_tokens || 0) * pw) / 1e6;
}

let history = [];

async function post(body) {
  const res = await fetch(`${base}/api/${state}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': userId, 'x-app-version': 'ask-cli' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

function render(answer) {
  return answer.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_, id, name) => `${name.trim()} (${id.trim()})`);
}

async function askOnce(q) {
  history.push({ role: 'user', content: q });
  const t0 = Date.now();
  const { status, json } = await post({ messages: history });
  if (status !== 200) {
    history.pop();
    console.log(`\n[HTTP ${status}] ${JSON.stringify(json)}\n`);
    return;
  }
  history.push({ role: 'assistant', content: json.answer_text || json.answer });
  console.log(`\n${render(json.answer)}\n`);
  if (json.lakes?.length) {
    console.log('lakes:');
    for (const l of json.lakes) {
      const bits = [l.county, l.acres != null ? `${Math.round(l.acres)} ac` : null,
        l.survey_year ? `surveyed ${l.survey_year}` : null,
        l.cpue != null ? `cpue ${l.cpue}` : null,
        l.avg_weight_lb != null ? `${l.avg_weight_lb} lb` : null,
        l.avg_length_in != null ? `${l.avg_length_in} in` : null,
        l.stocked_adults_per_100ac != null ? `${l.stocked_adults_per_100ac}/100ac stocked` : null].filter(Boolean);
      console.log(`  - ${l.lake_name} [${l.lake_id}] ${bits.join(' · ')}`);
    }
  }
  const u = json.usage || {};
  const cost = estCost(u);
  console.log(`\n(${u.model} · ${((Date.now() - t0) / 1000).toFixed(1)}s · ${u.iterations || '?'} calls · ${u.tool_calls || 0} tools · in ${u.input_tokens} / out ${u.output_tokens} · cache r${u.cache_read_input_tokens} w${u.cache_creation_input_tokens}${cost != null ? ` · ~$${cost.toFixed(4)}` : ''} · stop=${u.stop_reason})\n`);
}

async function main() {
  if (oneShot) { await askOnce(oneShot); return; }
  console.log(`LakeLore ask — ${base} · state ${state} · user ${userId}\n/new /tool /prompt /state /quit\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    const q = line.trim();
    try {
      if (!q) { /* ignore */ }
      else if (q === '/quit' || q === '/exit') { rl.close(); return; }
      else if (q === '/new') { history = []; console.log('(new conversation)'); }
      else if (q === '/prompt') {
        const { json } = await post({ tool: { name: 'system_prompt' } });
        console.log(json.system_prompt || JSON.stringify(json));
      }
      else if (q.startsWith('/state ')) { state = q.slice(7).trim(); history = []; console.log(`(state ${state})`); }
      else if (q.startsWith('/tool ')) {
        const m = q.match(/^\/tool\s+(\S+)\s*(.*)$/);
        const input = m[2] ? JSON.parse(m[2]) : {};
        const { status, json } = await post({ tool: { name: m[1], input } });
        console.log(`[HTTP ${status}]`, JSON.stringify(json, null, 1));
      }
      else await askOnce(q);
    } catch (e) { console.log(`error: ${e.message}`); }
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
}

main().catch(e => { console.error(e); process.exit(1); });
