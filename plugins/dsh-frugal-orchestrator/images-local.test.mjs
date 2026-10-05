/**
 * The image bridge against the REAL attachment service and the REAL gate.
 *
 * `images.test.mjs` installs the bridge directly with a fake `ctx.attachments`
 * and its own identity records. This file instead boots the plugin's own
 * `apply()` with a real `LocalAttachmentStore` (writing into a temporary
 * `DSH_HOME`, never the user's attachment store) and the plugin's own identity
 * adapters, so the parts that only exist in the integration are covered:
 *
 * - the Lead half and the worker half are registered by the gate into the right
 *   scopes (and the Lead never gets the delivery tool);
 * - a child's delivery is keyed by the ids the gate uses (parent session id +
 *   child session id) and survives as metadata only;
 * - the Lead's `target` is validated against the host's durable child catalog
 *   (`subagents.listChildren`), not against anything remembered in this process;
 * - a foreign Lead cannot read another Lead's child.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { load } from './test-runtime.mjs';

/**
 * The gate resolves the official tool factory through the profile (the profile's
 * `node_modules` holds `@deepseek-ai/schemastery`), so the profile has to be
 * named before `./index.js` is imported — the same discovery gate.test.mjs uses.
 */
function ensureProfileDir() {
  const configured = process.env.DSH_PROFILE_DIR;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  const root = join(homedir(), '.dsh', 'profiles');
  if (!existsSync(root)) throw new Error(`no dsh profiles under ${root}; set DSH_PROFILE_DIR`);
  for (const entry of readdirSync(root)) {
    const candidate = join(root, entry);
    if (existsSync(join(candidate, 'node_modules', '@deepseek-ai', 'schemastery'))) {
      process.env.DSH_PROFILE_DIR = candidate;
      return candidate;
    }
  }
  throw new Error(`no profile under ${root} has @deepseek-ai/schemastery; set DSH_PROFILE_DIR`);
}
ensureProfileDir();

const { Context } = await load('cordis/lib/index.js');
const { ToolRuntime } = await load('dsh-tools/lib/index.js');
const { SystemPrompt } = await load('dsh-system-prompt/lib/index.js');
const { SessionStore } = await load('dsh-session/lib/index.js');
const { SessionQueryEngine } = await load('dsh-session-query/lib/index.js');
const { LocalAttachmentStore } = await load('dsh-attachment-local/lib/index.js');
const { createScope } = await load('dsh-scope/lib/index.js');
const { apply, Config } = await import('./index.js');

/**
 * A REAL, decodable 1x1 PNG.
 *
 * The unit test's `PNG_1X1` fixture only carries a valid PNG signature, which is
 * all its fake seam checks — the real store decodes the bytes and refuses it
 * ("Unsupported or malformed image data"). This generator builds the container
 * (IHDR + deflate'd IDAT + IEND with real CRCs) so the real store accepts it.
 */
function makePng1x1() {
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      let value = (crc ^ byte) & 0xff;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crc = value ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0xff, 0x00, 0x00]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG_1X1 = makePng1x1();

const home = mkdtempSync(join(tmpdir(), 'frugal-images-local-'));
process.env.DSH_HOME = home;
const pngPath = join(home, 'shot.png');
writeFileSync(pngPath, PNG_1X1);

const signal = new AbortController().signal;
const ctx = new Context();
ctx.logger.level = 0;
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(SessionStore);
await ctx.plugin(SessionQueryEngine);
ctx.on('session/flush', () => {});
// The real service, with its own dshHome so nothing touches the user's store.
await ctx.plugin(LocalAttachmentStore, { dshHome: home });
assert.equal(typeof ctx.attachments?.saveImage, 'function', 'the real attachment service is up');
assert.ok(ctx.attachments.root.startsWith(home), 'and it writes inside the temporary DSH_HOME');

const live = new Map();
ctx.reflect.provide('agents', {
  get: (id) => live.get(id),
  list: () => [...live.values()],
  roots: () => [...live.values()].filter((agent) => !agent.session.header.parentSession),
});
ctx.reflect.provide('agentPresets', { composedPreset: () => 'frugal' });
// The host's durable child catalog seam. `listChildren` is intentionally the
// ONLY place a direct child is recognised: no in-process tracking.
const catalog = new Map();
ctx.reflect.provide('subagents', {
  listChildren: async (parentSessionId) => catalog.get(parentSessionId) ?? [],
});

const presetKey = { id: 'frugal' };
const presetScope = { ctx: undefined };
const makeAgent = async (id, parentId) => {
  const agent = {
    id,
    session: ctx.sessions.create(id, { meta: parentId === undefined ? {} : { parentSession: parentId, delegationDepth: 1 } }),
    options: {},
    status: 'idle',
    inbox: { hasPending: false },
  };
  await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(runtimeCtx) { agent.ctx = createScope(runtimeCtx, agent, { parent: presetKey }).ctx; } });
  live.set(id, agent);
  return agent;
};
await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(runtimeCtx) { presetScope.ctx = createScope(runtimeCtx, presetKey).ctx; } });
// The preset's own delegation surface, so the gate's restriction has the
// inherited names it expects to find.
await presetScope.ctx.plugin({
  inject: ['tools'],
  apply(scoped) {
    for (const name of ['subagent', 'ask_user_question']) {
      scoped.tools.register({
        name, description: name, parameters: {},
        output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: name }] },
        execute: async () => name,
      });
    }
  },
});

const config = Config({ subagentProvider: 'cheap', subagentModel: 'worker', diagnostics: true });
await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply: (scoped) => apply(scoped, config) });

const lead = await makeAgent('lead-session');
const worker = await makeAgent('worker-session', 'lead-session');
catalog.set('lead-session', [{ id: 'worker-session', mode: 'continuable', label: 'executor' }]);

await ctx.serial('agent/created', { agent: lead });
await ctx.serial('agent/created', { agent: worker });

const registry = ctx.get('tools');
const namesOf = (agent) => registry.schemas(agent).map((schema) => schema.name);
assert.ok(namesOf(lead).includes('read_delivered_images'), 'the gate registers the Lead read tool into the Lead scope');
assert.ok(!namesOf(lead).includes('deliver_images'), 'the Lead never gets the delivery tool');
assert.ok(namesOf(worker).includes('deliver_images'), 'the gate registers the delivery tool into the worker scope');
assert.ok(!namesOf(worker).includes('read_delivered_images'), 'a worker cannot read deliveries back');

let callSeq = 0;
const call = (name, args, agent) => registry.execute({
  name, callId: `${name}-${callSeq += 1}`, arguments: args, agent, signal,
});
const textOf = (result) => (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');

// ── The worker delivers a real file through the real attachment store ────────
const delivered = await call('deliver_images', { paths: [pngPath], note: '首帧截图' }, worker);
assert.notEqual(delivered.isError, true, `delivery failed: ${textOf(delivered)}`);
const deliveredText = JSON.stringify(delivered);
assert.match(deliveredText, /"count":1/, deliveredText);
assert.ok(!/iVBORw0KGgo/.test(deliveredText), 'the tool answer carries references, never base64');

// ── The Lead reads it back as a native image block ──────────────────────────
const read = await call('read_delivered_images', { target: 'worker-session' }, lead);
assert.notEqual(read.isError, true, `read failed: ${textOf(read)}`);
const imageBlocks = (read.content ?? []).filter((block) => block.type === 'image');
assert.equal(imageBlocks.length, 1, 'the Lead receives exactly one native image block');
assert.equal(imageBlocks[0].attachment.mediaType, 'image/png');
assert.equal(imageBlocks[0].attachment.bytes, PNG_1X1.byteLength, 'and the verified byte count matches the file');
assert.ok(imageBlocks[0].attachment.width >= 1 && imageBlocks[0].attachment.height >= 1);

// Reading twice does not re-inject the same image unless it is asked for.
const again = await call('read_delivered_images', { target: 'worker-session' }, lead);
assert.equal((again.content ?? []).filter((block) => block.type === 'image').length, 0, 'an already-read delivery is not injected again');
const forced = await call('read_delivered_images', { target: 'worker-session', include_read: true }, lead);
assert.equal((forced.content ?? []).filter((block) => block.type === 'image').length, 1, 'include_read: true shows it again');

// ── Ownership comes from the host catalog, not from this process ────────────
const foreignLead = await makeAgent('other-lead');
await ctx.serial('agent/created', { agent: foreignLead });
const foreign = await call('read_delivered_images', { target: 'worker-session' }, foreignLead);
assert.equal(foreign.isError, true, 'a foreign Lead cannot read another Lead\'s child deliveries');
assert.match(JSON.stringify(foreign), /IMAGE-NOT-A-DIRECT-CHILD/);
const unknown = await call('read_delivered_images', { target: 'nobody' }, lead);
assert.equal(unknown.isError, true, 'an unknown target is refused');
assert.match(JSON.stringify(unknown), /IMAGE-NOT-A-DIRECT-CHILD/);

// The worker's own half is not a Lead tool: the guard refuses it for the Lead.
const leadDeliver = await call('deliver_images', { paths: [pngPath] }, lead);
assert.equal(leadDeliver.isError, true, 'the Lead has no delivery tool to call');

// ── The record on disk is metadata only, under (parent, child) ──────────────

const storeDir = join(home, 'frugal-orchestrator', 'image-deliveries');
const files = readdirSync(storeDir);
assert.equal(files.length, 1, 'one record file per delivering child');
const raw = readFileSync(join(storeDir, files[0]), 'utf8');
const record = JSON.parse(raw);
assert.equal(record.parent, 'lead-session', 'the record names the parent session the gate resolved');
assert.equal(record.child, 'worker-session');
assert.match(files[0], /worker-session/, `the file is named after the child session: ${files[0]}`);
assert.equal(record.records.length, 1);
assert.match(record.records[0].ref.attachmentId, /^sha256:/, 'and it stores a content-addressed reference');
assert.ok(!/base64/.test(raw) && !raw.includes(PNG_1X1.toString('base64').slice(0, 24)),
  'the record carries no image bytes');
assert.equal(record.records[0].bytes ?? record.records[0].ref.bytes, PNG_1X1.byteLength);

console.log('frugal-orchestrator image bridge: real LocalAttachmentStore + real gate registration, '
  + 'worker delivery, Lead read (native image block), already-read suppression, include_read, '
  + 'foreign/unknown target refusal and metadata-only records passed');
