// Offline harness for the explicit image bridge
// (plugins/dsh-frugal-orchestrator/lib/images.js).
//
// What is REAL here:
//   @deepseek-ai/cordis      — Context and effect-scoped plugin application
//   @deepseek-ai/dsh-scope   — createScope, so each agent's tools register into
//                              that agent's OWN layer, exactly as production does
//   @deepseek-ai/dsh-tools   — the real ToolRuntime + defineTool: argument
//                              validation, the scoped view, and the rendered
//                              model-facing content blocks are the host's own
//   node:fs/promises         — the source images are real files in a temp dir,
//                              the file store really writes/renames/reads them
//   a FRESH module instance  — the read half runs through a re-imported
//                              `lib/images.js?fresh=…`, so nothing can be shared
//                              in memory between "deliver" and "read"
//
// What is FAKE: the `ctx.attachments` service. The real LocalAttachmentStore
// needs a DSH home and image decoding; this harness reproduces its published
// contract instead — `saveImage({ data, mediaType, name })` validating bytes and
// returning a content-addressed reference, `readImage(ref)` verifying that the
// bytes still match. It never talks to a model, a live dsh process, or the user's
// profile.
//
//   node images.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_IMAGE_BRIDGE_LIMITS,
  DELIVER_TOOL_NAME,
  IMAGE_TOOL_NAMES,
  READ_TOOL_NAME,
  buildImageTools,
  createFileStore,
  createMemoryStore,
  imageMediaTypeOfPath,
  installImageBridge,
} from './lib/images.js';
import { load } from './test-runtime.mjs';

const { Context } = await load('cordis/lib/index.js');
const { ToolRuntime, defineTool } = await load('dsh-tools/lib/index.js');
const { SystemPrompt } = await load('dsh-system-prompt/lib/index.js');
const { createScope } = await load('dsh-scope/lib/index.js');

/** A real 1x1 PNG (signature + IHDR + IDAT + IEND). */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+7gAAAABJRU5ErkJggg==',
  'base64',
);

const root = await mkdtemp(join(tmpdir(), 'frugal-images-'));
process.env.DSH_HOME = root;

/**
 * The fake `ctx.attachments` seam.
 *
 * `saveImage` refuses bytes that do not carry the declared raster signature, so
 * a misleading extension fails where the real service would fail. `forget()`
 * models an object collected before its reference was read.
 */
function fakeAttachments() {
  const stored = new Map();
  let seq = 0;
  return {
    stored,
    forget(imageId) {
      stored.delete(imageId);
    },
    async saveImage({ data, mediaType, name }) {
      if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new Error('the image bytes are empty');
      if (mediaType === 'image/png' && !(data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47)) {
        throw new Error('the bytes are not a PNG');
      }
      seq += 1;
      const attachmentId = `sha256:${String(seq).padStart(64, '0')}`;
      const ref = {
        attachmentId,
        mediaType,
        bytes: data.byteLength,
        width: 1,
        height: 1,
        ...name === undefined ? {} : { name },
      };
      stored.set(attachmentId, { ref, data: Uint8Array.from(data) });
      return ref;
    },
    async readImage(ref) {
      const entry = stored.get(ref?.attachmentId);
      if (entry === undefined) {
        throw Object.assign(new Error(`attachment ${ref?.attachmentId} is not stored`), { code: 'ATTACHMENT_NOT_FOUND' });
      }
      if (ref.bytes !== undefined && ref.bytes !== entry.ref.bytes) throw new Error('the stored bytes no longer match the reference');
      return { ref: entry.ref, data: Uint8Array.from(entry.data) };
    },
  };
}

/**
 * Mount one agent on the real stack and give it its own scope.
 * @param scopeFactory - the runtime context factory created once by {@link mount}.
 * @param agent - `{ id, session: { id } }`; `.ctx` is filled in here.
 * @param presetKey - the parent scope key.
 */
function scopeFor(runtimeCtx, agent, presetKey) {
  const scope = createScope(runtimeCtx, agent, { parent: presetKey });
  agent.ctx = scope.ctx;
  return scope;
}

/** Register a factory's tools into one scope's own layer. */
async function withScopeTools(scopeCtx, factory) {
  let result;
  await scopeCtx.plugin({
    name: `images-register-${Math.random().toString(36).slice(2)}`,
    inject: ['tools'],
    apply(toolCtx) {
      result = factory(toolCtx.tools);
    },
  });
  return result;
}

/** The harness root: one real ToolRuntime, one preset scope, factory for agent scopes. */
async function mount() {
  const ctx = new Context();
  // ToolRuntime injects `systemPrompt`, so the real prompt service comes first.
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  const presetKey = { kind: 'preset', id: 'frugal' };
  let runtimeCtx;
  await ctx.plugin({ name: 'images-runtime', inject: ['tools'], apply(inner) { runtimeCtx = inner; } });
  const preset = createScope(runtimeCtx, presetKey);
  // A scope key binds to one parent exactly once, so agents get one scope each.
  const scopes = new Map();
  return {
    ctx,
    registry: ctx.get('tools'),
    scopeOf: (agent) => {
      if (!scopes.has(agent)) scopes.set(agent, scopeFor(runtimeCtx, agent, presetKey));
      return scopes.get(agent);
    },
    presetCtx: preset.ctx,
  };
}

/** One agent stub: the identity facts live in the callbacks, not here. */
const agentOf = (id) => ({ id, session: { id } });

/** Text of one tool result's rendered content. */
const textOf = (result) => result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
/** Image blocks of one tool result's rendered content. */
const imagesOf = (result) => result.content.filter((block) => block.type === 'image');
/**
 * Assert one tool call failed with a stable error code.
 *
 * The real ToolRuntime materializes a thrown tool error as an error RESULT, not
 * as a rejection, so the code has to be read from `error.info.code`.
 */
async function errorCodeOf(promise, code) {
  const result = await promise;
  assert.equal(result.isError, true, `expected an error result, got value ${JSON.stringify(result.value)}`);
  assert.equal(result.error?.info?.code, code, result.error?.message);
  return result;
}

/**
 * The identity seam for SUBAGENT mode: the worker is a delegated child, its
 * parent is the Lead, and the Lead resolves one of its own children by id.
 */
function subagentIdentity(lead, children, calls = {}) {
  return {
    mayDeliver: (agent) => children.some((child) => child.id === agent.id),
    mayRead: (agent) => agent.id === lead.id,
    idOf: (agent) => agent.session.id,
    parentIdOf: () => lead.session.id,
    sessionIdOf: (agent) => agent.session.id,
    taskIdOf: (agent) => calls.task?.[agent.id],
    resolveTarget: (caller, target) => {
      const child = children.find((entry) => entry.id === target);
      if (child === undefined || caller.id !== lead.id) return undefined;
      return { childId: child.id, parentId: lead.session.id, sessionId: child.session.id };
    },
    now: () => Date.parse('2026-10-05T06:40:00.000Z'),
  };
}

/** Write one image file and return its absolute path. */
async function writeImage(name, bytes = PNG_1X1) {
  const path = join(root, name);
  await writeFile(path, bytes);
  return path;
}

/** Build the two bridge halves over one shared store. */
function bridgeFor(harness, options) {
  const { worker, lead, identity, attachments, store, limits, readFile } = options;
  const workerScope = harness.scopeOf(worker);
  const leadScope = harness.scopeOf(lead);
  return (async () => {
    const workerSide = await withScopeTools(workerScope.ctx, (registry) => installImageBridge({
      agent: worker, role: 'worker', registry, defineTool, attachments, store, identity, limits, readFile,
    }));
    const leadSide = await withScopeTools(leadScope.ctx, (registry) => installImageBridge({
      agent: lead, role: 'lead', registry, defineTool, attachments, store, identity, limits, readFile,
    }));
    return { workerSide, leadSide };
  })();
}

let callSeq = 0;
const call = (harness, name, args, agent) => harness.registry.execute({
  name,
  callId: `${name}-${callSeq += 1}`,
  arguments: args,
  agent,
  signal: new AbortController().signal,
});

// ── Contract: ownership and storage seams are fail-closed ───────────────────
{
  assert.deepEqual(IMAGE_TOOL_NAMES, [DELIVER_TOOL_NAME, READ_TOOL_NAME]);
  assert.equal(imageMediaTypeOfPath('C:\\shots\\a.PNG'), 'image/png');
  assert.equal(imageMediaTypeOfPath('/tmp/a.jpeg'), 'image/jpeg');
  assert.equal(imageMediaTypeOfPath('/tmp/a.bmp'), undefined);

  const attachments = fakeAttachments();
  const store = createMemoryStore();
  const worker = agentOf('worker-1');
  const base = { agent: worker, role: 'worker', defineTool, attachments, store };
  assert.throws(
    () => buildImageTools({ ...base, identity: { mayDeliver: () => true } }),
    (error) => error.code === 'IMAGE-TOOLS-UNAVAILABLE' && /identity\.idOf\(\)/.test(error.message),
    'identity callbacks are required, not inferred',
  );
  assert.throws(
    () => buildImageTools({ ...base, defineTool: undefined, identity: { mayDeliver: () => true, idOf: () => 'w', parentIdOf: () => 'p' } }),
    (error) => error.code === 'IMAGE-TOOLS-UNAVAILABLE',
  );
  assert.throws(
    () => createFileStore({ dir: 'relative/dir' }),
    (error) => error.code === 'IMAGE-STORE-DIR' && /ABSOLUTE/.test(error.message),
    'a relative store dir is refused so records can never land in a checkout',
  );
  assert.throws(
    () => buildImageTools({
      ...base,
      identity: { mayDeliver: () => true, idOf: () => 'w', parentIdOf: () => 'p' },
      limits: { maxImagesPerDelivery: 0 },
    }),
    (error) => error.code === 'IMAGE-LIMITS',
  );
  assert.equal(DEFAULT_IMAGE_BRIDGE_LIMITS.maxImagesPerDelivery, 4);
  console.log('  contract: identity/store/limit seams fail closed');
}

// ── The happy path through the REAL ToolRuntime, then a FRESH module read ───
{
  const harness = await mount();
  const attachments = fakeAttachments();
  const storeDir = join(root, 'deliveries');
  const worker = agentOf('worker-happy');
  const lead = agentOf('lead-happy');
  const identity = subagentIdentity(lead, [worker], { task: { 'worker-happy': 'task-2' } });
  const { workerSide, leadSide } = await bridgeFor(harness, {
    worker, lead, identity, attachments, store: createFileStore({ dir: storeDir }),
  });
  const deliveredPath = await writeImage('happy-a.png');

  const deliver = await call(harness, DELIVER_TOOL_NAME, { paths: [deliveredPath], note: 'the rendered chart' }, worker);
  assert.equal(deliver.isError, false, textOf(deliver));
  assert.equal(deliver.value.count, 1);
  assert.equal(deliver.value.child, worker.session.id);
  assert.equal(deliver.value.note, 'the rendered chart');
  assert.deepEqual(deliver.value.failed, []);
  const imageId = deliver.value.delivered[0].image_id;
  assert.match(imageId, /^sha256:/);
  assert.equal(deliver.value.delivered[0].media_type, 'image/png');
  assert.ok(textOf(deliver).includes(`${READ_TOOL_NAME}({ target: "${worker.session.id}" })`), textOf(deliver));
  assert.equal(imagesOf(deliver).length, 0, 'the delivery itself carries no image block');

  // Persisted records: metadata only — no bytes, no base64.
  const files = await readdir(storeDir);
  assert.equal(files.length, 1, `one store file per child: ${files.join(', ')}`);
  assert.ok(!files.some((name) => name.endsWith('.tmp')), 'the atomic stage file is gone');
  const raw = await readFile(join(storeDir, files[0]), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].image_id, imageId);
  assert.equal(parsed.records[0].parent, lead.session.id);
  assert.equal(parsed.records[0].child, worker.session.id);
  assert.equal(parsed.records[0].session, worker.session.id);
  assert.equal(parsed.records[0].task, 'task-2');
  assert.equal(parsed.records[0].note, 'the rendered chart');
  assert.equal(parsed.records[0].time, '2026-10-05T06:40:00.000Z');
  assert.ok(!/base64|iVBORw0KGgo/.test(raw), 'the record never stores image bytes');

  // Re-installing the Lead half releases the previous registration first, the
  // way a `loader/volatile-update` re-application does.
  for (const dispose of leadSide.disposers) dispose();

  // A FRESH module instance + a fresh store over the same directory: the read
  // half shares nothing in memory with the write half.
  const fresh = await import(`${pathToFileURL(join(import.meta.dirname, 'lib', 'images.js')).href}?fresh=${Date.now()}`);
  assert.notEqual(fresh.createFileStore, createFileStore, 'a different module instance is in play');
  const freshScope = harness.scopeOf(lead);
  const freshSide = await withScopeTools(freshScope.ctx, (registry) => fresh.installImageBridge({
    agent: lead, role: 'lead', registry, defineTool,
    attachments, store: fresh.createFileStore({ dir: storeDir }), identity,
  }));
  assert.equal(freshSide.definitions[READ_TOOL_NAME].name, READ_TOOL_NAME);

  // The lead's FIRST read goes through the fresh module's tool.
  const read = await call(harness, READ_TOOL_NAME, { target: worker.id }, lead);
  assert.equal(read.isError, false, textOf(read));
  assert.equal(read.value.count, 1);
  assert.equal(read.value.child, worker.id);
  assert.equal(read.value.session, worker.session.id);
  assert.equal(read.value.note, 'the rendered chart');
  const blocks = imagesOf(read);
  assert.equal(blocks.length, 1, textOf(read));
  assert.deepEqual(blocks[0], {
    type: 'image',
    attachment: {
      attachmentId: imageId, mediaType: 'image/png', bytes: PNG_1X1.byteLength, width: 1, height: 1, name: 'happy-a.png',
    },
  }, 'the rendered block is the verified durable reference');
  assert.ok(textOf(read).includes(imageId), textOf(read));
  assert.equal(read.value.missing.length, 0);

  // Already-read deliveries stay out of the next request unless asked for.
  const again = await call(harness, READ_TOOL_NAME, { target: worker.id }, lead);
  assert.equal(again.value.count, 0);
  assert.equal(again.value.skipped_read, 1);
  assert.equal(imagesOf(again).length, 0);
  const reRead = await call(harness, READ_TOOL_NAME, { target: worker.id, include_read: true }, lead);
  assert.equal(reRead.value.count, 1);
  assert.equal(imagesOf(reRead).length, 1, 'include_read re-renders it');
  assert.equal(workerSide.disposers.length, 1);
  assert.equal(leadSide.disposers.length, 1);
  console.log('  happy path: deliver -> file store -> fresh module read -> native image block');
}

// ── Multiple images, per-read cap, byte/count/path/type limits ─────────────
{
  const harness = await mount();
  const attachments = fakeAttachments();
  const worker = agentOf('worker-multi');
  const other = agentOf('worker-multi-2');
  const lead = agentOf('lead-multi');
  // ONE store and ONE identity see both children: a second Lead half would be a
  // re-install, and a second store would hide the first worker's records.
  const identity = subagentIdentity(lead, [worker, other]);
  const store = createMemoryStore();
  await bridgeFor(harness, { worker, lead, identity, attachments, store });
  const otherScope = harness.scopeOf(other);
  await withScopeTools(otherScope.ctx, (registry) => installImageBridge({
    agent: other, role: 'worker', registry, defineTool, attachments, store, identity,
  }));

  const paths = await Promise.all(['multi-1.png', 'multi-2.png', 'multi-3.png'].map((name) => writeImage(name)));
  const deliver = await call(harness, DELIVER_TOOL_NAME, { paths }, worker);
  assert.equal(deliver.isError, false, textOf(deliver));
  assert.equal(deliver.value.count, 3);

  const read = await call(harness, READ_TOOL_NAME, { target: worker.id }, lead);
  assert.equal(read.isError, false, textOf(read));
  assert.equal(read.value.count, 3);
  assert.equal(imagesOf(read).length, 3, 'every delivered image renders');
  assert.equal(new Set(imagesOf(read).map((block) => block.attachment.attachmentId)).size, 3);

  // A second worker delivers into its own bucket; the Lead reads per target.
  const otherPath = await writeImage('other.png');
  await call(harness, DELIVER_TOOL_NAME, { paths: [otherPath] }, other);
  const otherRead = await call(harness, READ_TOOL_NAME, { target: other.id }, lead);
  assert.equal(otherRead.isError, false, textOf(otherRead));
  assert.equal(otherRead.value.count, 1, 'the second worker read has only its own image');

  // Limits: a dedicated installation with small bounds proves each knob.
  const tiny = agentOf('worker-tiny-limits');
  const tinyScope = harness.scopeOf(tiny);
  await withScopeTools(tinyScope.ctx, (registry) => installImageBridge({
    agent: tiny,
    role: 'worker',
    registry,
    defineTool,
    attachments,
    store,
    identity: { ...identity, mayDeliver: (agent) => agent.id === tiny.id },
    limits: { maxPathsPerCall: 3, maxImageBytes: 512, maxDeliveryBytes: 800 },
  }));
  const paddedPng = (size) => Buffer.concat([PNG_1X1, Buffer.alloc(Math.max(0, size - PNG_1X1.length), 3)]);
  await errorCodeOf(
    call(harness, DELIVER_TOOL_NAME, {
      paths: Array.from({ length: 4 }, (_, index) => join(root, `tiny-${index}.png`)),
    }, tiny),
    'IMAGE-TOO-MANY-PATHS',
  );
  const tooBig = await writeImage('too-big.png', paddedPng(600));
  const bigDeliver = await call(harness, DELIVER_TOOL_NAME, { paths: [tooBig] }, tiny);
  assert.match(bigDeliver.value.failed[0].reason, /exceeds the per-image limit/);
  const nearLimit = await Promise.all([writeImage('near-1.png', paddedPng(500)), writeImage('near-2.png', paddedPng(500))]);
  const capped = await call(harness, DELIVER_TOOL_NAME, { paths: nearLimit }, tiny);
  assert.equal(capped.value.count, 1, 'the first image fits the delivery budget');
  assert.match(capped.value.failed[0].reason, /per-delivery byte limit/, JSON.stringify(capped.value.failed));

  const notPng = await writeImage('liar.png', Buffer.from('definitely not a png'));
  const mixed = await call(harness, DELIVER_TOOL_NAME, {
    paths: [
      join(root, 'missing.png'),
      'relative.png',
      join(root, 'sketch.bmp'),
      notPng,
      await writeImage('multi-4.png'),
    ],
  }, worker);
  assert.equal(mixed.isError, false, 'a partly bad call is a structured result, not a failed step');
  assert.equal(mixed.value.count, 1);
  assert.equal(mixed.value.failed.length, 4);
  const reasons = mixed.value.failed.map((entry) => entry.reason).join(' | ');
  assert.match(reasons, /could not be read/);
  assert.match(reasons, /not absolute/);
  assert.match(reasons, /unsupported image extension/);
  assert.match(reasons, /refused it/);
  console.log('  limits: multi-image, per-target buckets, path/type/size diagnostics');
}

// ── Refusals: foreign callers, non-children, other Leads, non-Leads ─────────
{
  const harness = await mount();
  const attachments = fakeAttachments();
  const worker = agentOf('worker-deny');
  const intruder = agentOf('worker-intruder');
  const lead = agentOf('lead-deny');
  const otherLead = agentOf('lead-other');
  const identity = subagentIdentity(lead, [worker]);
  const store = createMemoryStore();
  const { leadSide } = await bridgeFor(harness, { worker, lead, identity, attachments, store });
  const path = await writeImage('deny-a.png');
  await call(harness, DELIVER_TOOL_NAME, { paths: [path] }, worker);

  // Layer isolation: the Lead's tool is registered in the LEAD's own scope, so
  // another agent's view of the registry does not contain it at all.
  await errorCodeOf(call(harness, READ_TOOL_NAME, { target: worker.id }, intruder), 'UNKNOWN_TOOL');
  // And the definition itself refuses a caller that is not its own agent, the
  // same second line `buildTools` holds in the delegation module.
  await assert.rejects(
    leadSide.definitions[READ_TOOL_NAME].execute({ target: worker.id }, { agent: intruder, signal: new AbortController().signal }),
    (error) => error.code === 'IMAGE-FOREIGN-CALLER',
  );
  // A non-Lead caller is refused even with the right tool instance.
  const noRead = { ...identity, mayRead: () => false };
  const leadScope = harness.scopeOf(otherLead);
  await withScopeTools(leadScope.ctx, (registry) => installImageBridge({
    agent: otherLead, role: 'lead', registry, defineTool, attachments, store, identity: noRead,
  }));
  await errorCodeOf(call(harness, READ_TOOL_NAME, { target: worker.id }, otherLead), 'IMAGE-NOT-THE-LEAD');
  // A target that is not the caller's direct child is refused.
  const foreign = {
    ...identity,
    mayRead: (agent) => agent.id === intruder.id,
    resolveTarget: (caller, target) => (target === 'ghost-child' ? undefined : identity.resolveTarget(caller, target)),
  };
  const otherScope = harness.scopeOf(intruder);
  await withScopeTools(otherScope.ctx, (registry) => installImageBridge({
    agent: intruder, role: 'lead', registry, defineTool, attachments, store, identity: foreign,
  }));
  await errorCodeOf(call(harness, READ_TOOL_NAME, { target: 'ghost-child' }, intruder), 'IMAGE-NOT-A-DIRECT-CHILD');
  // A direct child owned by ANOTHER Lead is refused by the parent check.
  const otherChild = agentOf('child-of-other');
  const stolen = {
    ...identity,
    mayRead: (agent) => agent.id === thief.id,
    resolveTarget: () => ({ childId: otherChild.id, parentId: otherLead.session.id }),
  };
  const thief = agentOf('lead-thief');
  const thiefScope = harness.scopeOf(thief);
  await withScopeTools(thiefScope.ctx, (registry) => installImageBridge({
    agent: thief, role: 'lead', registry, defineTool, attachments, store, identity: stolen,
  }));
  await errorCodeOf(call(harness, READ_TOOL_NAME, { target: otherChild.id }, thief), 'IMAGE-NOT-YOUR-CHILD');
  // deliver_images belongs to a worker; the Lead cannot be made to deliver.
  const leadAsWorker = agentOf('lead-as-worker');
  const asWorkerScope = harness.scopeOf(leadAsWorker);
  await withScopeTools(asWorkerScope.ctx, (registry) => installImageBridge({
    agent: leadAsWorker, role: 'worker', registry, defineTool, attachments, store, identity: { ...identity, mayDeliver: () => false },
  }));
  await errorCodeOf(call(harness, DELIVER_TOOL_NAME, { paths: [path] }, leadAsWorker), 'IMAGE-NOT-A-WORKER');
  console.log('  refusals: foreign caller, non-Lead, non-child, other Lead, non-worker');
}

// ── A collected/corrupt image degrades to text, never to a failed step ─────
{
  const harness = await mount();
  const attachments = fakeAttachments();
  const worker = agentOf('worker-broken');
  const lead = agentOf('lead-broken');
  const identity = subagentIdentity(lead, [worker]);
  const store = createMemoryStore();
  await bridgeFor(harness, { worker, lead, identity, attachments, store });
  const good = await writeImage('broken-good.png');
  const bad = await writeImage('broken-bad.png');
  const deliver = await call(harness, DELIVER_TOOL_NAME, { paths: [good, bad] }, worker);
  assert.equal(deliver.value.count, 2);
  attachments.forget(deliver.value.delivered[1].image_id);

  const read = await call(harness, READ_TOOL_NAME, { target: worker.id }, lead);
  assert.equal(read.isError, false, 'a missing object must not fail the model request');
  assert.equal(read.value.count, 1);
  assert.equal(imagesOf(read).length, 1, 'the surviving image still renders');
  assert.equal(read.value.missing.length, 1);
  assert.match(read.value.missing[0].reason, /not stored/);
  assert.match(textOf(read), /UNAVAILABLE/);
  assert.match(textOf(read), /deliver it again/);

  // A reference whose bytes no longer match is reported the same way.
  const second = await writeImage('broken-again.png');
  const secondDeliver = await call(harness, DELIVER_TOOL_NAME, { paths: [second] }, worker);
  const tampered = attachments.stored.get(secondDeliver.value.delivered[0].image_id);
  tampered.ref = { ...tampered.ref, bytes: tampered.ref.bytes + 1 };
  const mismatch = await call(harness, READ_TOOL_NAME, { target: worker.id }, lead);
  const mismatchMissing = mismatch.value.missing.find((entry) => entry.image_id === secondDeliver.value.delivered[0].image_id);
  assert.ok(mismatchMissing !== undefined, JSON.stringify(mismatch.value));
  assert.match(mismatchMissing.reason, /no longer match/);
  console.log('  degradation: collected and mismatched images become diagnostics');
}

// ── One module, two coordination modes ─────────────────────────────────────
{
  const harness = await mount();
  const attachments = fakeAttachments();

  // SUBAGENT mode: a delegated child delivers to its Lead by parent id.
  const child = agentOf('mode-subagent-child');
  const lead = agentOf('mode-lead');
  const subagentIdentitySeam = subagentIdentity(lead, [child]);
  await bridgeFor(harness, { worker: child, lead, identity: subagentIdentitySeam, attachments, store: createMemoryStore() });
  const subPath = await writeImage('mode-subagent.png');
  const subDeliver = await call(harness, DELIVER_TOOL_NAME, { paths: [subPath] }, child);
  assert.equal(subDeliver.value.count, 1);
  const subRead = await call(harness, READ_TOOL_NAME, { target: child.id }, lead);
  assert.equal(subRead.value.count, 1);
  assert.equal(imagesOf(subRead).length, 1);

  // TEAM mode: a teammate is addressed by its member NAME, and the membership
  // facts (not the module) decide who may deliver and what a name resolves to.
  const teammate = agentOf('mode-teammate-id');
  const teamLead = agentOf('mode-lead-2');
  const members = [{ name: 'reviewer', id: teammate.id, role: 'teammate' }];
  const teamIdentity = {
    mayDeliver: (agent) => members.some((member) => member.id === agent.id && member.role === 'teammate'),
    mayRead: (agent) => agent.id === teamLead.id,
    idOf: (agent) => agent.session.id,
    parentIdOf: () => teamLead.session.id,
    resolveTarget: (caller, target) => {
      const member = members.find((entry) => entry.name === target || entry.id === target);
      if (member === undefined || caller.id !== teamLead.id) return undefined;
      return { childId: member.id, parentId: teamLead.session.id, sessionId: member.id };
    },
  };
  await bridgeFor(harness, {
    worker: teammate, lead: teamLead, identity: teamIdentity, attachments, store: createMemoryStore(),
  });
  const teamPath = await writeImage('mode-team.png');
  const teamDeliver = await call(harness, DELIVER_TOOL_NAME, { paths: [teamPath], note: 'team evidence' }, teammate);
  assert.equal(teamDeliver.value.count, 1);
  const teamRead = await call(harness, READ_TOOL_NAME, { target: 'reviewer' }, teamLead);
  assert.equal(teamRead.isError, false, textOf(teamRead));
  assert.equal(teamRead.value.count, 1);
  assert.equal(teamRead.value.target, 'reviewer');
  assert.deepEqual(imagesOf(teamRead).map((block) => block.attachment.attachmentId), [teamDeliver.value.delivered[0].image_id]);
  // A teammate cannot read its own delivery back through the Lead tool.
  await errorCodeOf(call(harness, READ_TOOL_NAME, { target: 'reviewer' }, teammate), 'UNKNOWN_TOOL');
  // task-scoped reads filter the records the worker recorded.
  const taskIdentity = { ...teamIdentity, taskIdOf: () => 'task-9' };
  const teammate2 = agentOf('mode-teammate-2');
  const taskLead = agentOf('mode-lead-3');
  const members2 = [{ name: 'executor', id: teammate2.id, role: 'teammate' }];
  await bridgeFor(harness, {
    worker: teammate2,
    lead: taskLead,
    identity: {
      ...taskIdentity,
      mayDeliver: (agent) => members2.some((member) => member.id === agent.id),
      mayRead: (agent) => agent.id === taskLead.id,
      parentIdOf: () => taskLead.session.id,
      resolveTarget: (caller, target) => (target === 'executor' && caller.id === taskLead.id
        ? { childId: teammate2.id, parentId: taskLead.session.id, sessionId: teammate2.id }
        : undefined),
    },
    attachments,
    store: createMemoryStore(),
  });
  const taskPath = await writeImage('mode-task.png');
  await call(harness, DELIVER_TOOL_NAME, { paths: [taskPath] }, teammate2);
  const wrongTask = await call(harness, READ_TOOL_NAME, { target: 'executor', task_id: 'task-other' }, taskLead);
  assert.equal(wrongTask.value.count, 0);
  const rightTask = await call(harness, READ_TOOL_NAME, { target: 'executor', task_id: 'task-9' }, taskLead);
  assert.equal(rightTask.value.count, 1);
  console.log('  modes: the same module serves subagent ids and Team member names');
}

console.log('images.test.mjs: all assertions passed');
