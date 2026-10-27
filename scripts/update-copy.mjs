// Brings a copy of this project (the repository the Deploy button made) up to
// a release, keeping what Cloudflare wrote into that copy on deploy: the
// Worker's name, its two KV namespaces (LISTINGS and SITE, where the published
// site lives) and the values entered on the deploy page.
// Run by docs/update-workflow.yml in the host's copy:
//   node update-copy.mjs <release folder> <copy folder>
import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [release, copy] = process.argv.slice(2);
if (!release || !copy) {
  console.error('usage: node update-copy.mjs <release folder> <copy folder>');
  process.exit(1);
}

/** JSON with // and /* comments (wrangler.jsonc). Strings may contain "//", as in URLs. */
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      let j = end;
      while (text[j - 1] === '\\') j = text.indexOf('"', j + 1);
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i) - 1;
      if (i < 0) break;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i) + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// What the copy's deploy decided.
const mine = parseJsonc(readFileSync(join(copy, 'wrangler.jsonc'), 'utf8'));
const myName = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')).name;
// Losing the SITE id would make Cloudflare create an empty namespace: the site would vanish.
const BINDINGS = ['LISTINGS', 'SITE'];
const kvIds = Object.fromEntries(BINDINGS.map((b) => [b, (mine.kv_namespaces || []).find((k) => k.binding === b)?.id]).filter(([, id]) => id));
const myVars = mine.vars || {};

// Replace everything but git and GitHub settings with the release.
const KEEP = new Set(['.git', '.github']);
for (const entry of readdirSync(copy)) if (!KEEP.has(entry)) rmSync(join(copy, entry), { recursive: true, force: true });
for (const entry of readdirSync(release)) if (!KEEP.has(entry)) cpSync(join(release, entry), join(copy, entry), { recursive: true });

// The release's wrangler.jsonc, with this copy's name, storage and values.
let config = readFileSync(join(copy, 'wrangler.jsonc'), 'utf8');
const str = (v) => JSON.stringify(String(v));
config = config.replace(/"name"\s*:\s*"[^"]*"/, `"name": ${str(mine.name)}`);
for (const [binding, id] of Object.entries(kvIds)) {
  if (new RegExp(`"binding"\\s*:\\s*"${binding}"\\s*,\\s*"id"`).test(config)) continue;
  config = config.replace(new RegExp(`"binding"\\s*:\\s*"${binding}"`), `"binding": "${binding}", "id": ${str(id)}`);
}
config = config.replace(/("vars"\s*:\s*\{)([^}]*)(\})/, (all, open, body, close) => {
  for (const [key, value] of Object.entries(myVars)) {
    const line = new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`);
    if (line.test(body)) {
      body = body.replace(line, (m, k) => k + str(value));
    } else {
      const last = [...body.matchAll(/"(?:[^"\\]|\\.)*"\s*:\s*"(?:[^"\\]|\\.)*"/g)].pop();
      const at = last ? last.index + last[0].length : 0;
      body = body.slice(0, at) + `${last ? ',' : ''}\n    "${key}": ${str(value)}` + body.slice(at);
    }
  }
  return open + body + close;
});
const result = parseJsonc(config); // still valid
for (const [binding, id] of Object.entries(kvIds)) {
  if (result.kv_namespaces?.find((k) => k.binding === binding)?.id !== id) throw new Error(`Could not keep the ${binding} namespace id`);
}
writeFileSync(join(copy, 'wrangler.jsonc'), config);

const pkg = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8'));
pkg.name = myName;
writeFileSync(join(copy, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

const kept = Object.keys(kvIds);
console.log(`Updated to ${pkg.version}, keeping the Worker name "${mine.name}"${kept.length ? `, its ${kept.join(' and ')} namespace${kept.length > 1 ? 's' : ''}` : ''} and ${Object.keys(myVars).length} deploy-page value(s).`);
