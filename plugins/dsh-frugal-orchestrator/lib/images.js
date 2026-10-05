/**
 * Explicit image delivery between a working agent and its Lead.
 *
 * WHY AN EXPLICIT BRIDGE: a child agent cannot hand an image back as its own
 * answer. DSH's canonical final child output is the last non-empty assistant
 * message (`@deepseek-ai/dsh-subagent/assistant-output`), and the production
 * adapters declare text-only assistant output, so images are legal only in user
 * content and tool results (`@deepseek-ai/dsh-llm` types: "assistant-side
 * rendering is forward compatibility … only user messages may carry images").
 * The native `subagent` result projection drops non-text blocks as well. The ONE
 * channel that really reaches the Lead's model is an image block inside a TOOL
 * RESULT, which both shipped routes serialize (`dsh-llm-pi-ai` refuses images
 * only in messages that are neither user nor tool; the DeepSeek Messages
 * serializer emits `tool_result` content through the same image path).
 *
 * WHY NOT A LOG SCAN: every image the worker ever saw — including pictures the
 * user handed to it — lives in its session log and in the same attachment store
 * (`<DSH_HOME>/attachments/v1`, content-addressed, no per-agent authorization).
 * Sweeping the child's history would silently pull unrelated user images into
 * the Lead's context, so this module only ever returns references a worker
 * EXPLICITLY delivered through {@link DELIVER_TOOL_NAME}.
 *
 * Storage holds metadata only (attachment references, ids, timestamps, an
 * optional short note) — never image bytes and never base64.
 *
 * @module @nu11dev/dsh-frugal-orchestrator/lib/images
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile as readFileDefault, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { requireFromBases } from './resolve.js';

/** The worker-facing tool: hand one or more on-disk images to the Lead. */
export const DELIVER_TOOL_NAME = 'deliver_images';
/** The Lead-facing tool: read what one direct child delivered, as image blocks. */
export const READ_TOOL_NAME = 'read_delivered_images';
/** Every name this module can register. */
export const IMAGE_TOOL_NAMES = Object.freeze([DELIVER_TOOL_NAME, READ_TOOL_NAME]);

/** Media types the attachment service accepts, by file extension. */
const MEDIA_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
});

/**
 * Deployment limits, so one call can neither exhaust memory nor blow a route's
 * request-image budget (an over-budget request fails the whole step).
 */
export const DEFAULT_IMAGE_BRIDGE_LIMITS = Object.freeze({
  /** Absolute paths accepted by one `deliver_images` call. */
  maxPathsPerCall: 8,
  /** Images one delivery may persist. */
  maxImagesPerDelivery: 4,
  /** Bytes of one source file. */
  maxImageBytes: 12 * 1024 * 1024,
  /** Bytes of all images in one delivery. */
  maxDeliveryBytes: 24 * 1024 * 1024,
  /** Newest records kept per (parent, child). */
  maxRecordsPerChild: 24,
  /** Image blocks one read renders. */
  maxImagesPerRead: 4,
});

/** One thrown-value rendering that cannot itself throw. */
function describeThrown(value) {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    return String(value);
  } catch {
    return '<unprintable>';
  }
}

/** Memoised `HarnessError` class, or undefined when the runtime is unreachable. */
const harnessState = { error: undefined, tried: false };

/**
 * Resolve the host's `HarnessError` the way the delegation module resolves
 * `defineTool`: from the profile or the dsh install, never from a bare import
 * that a linked install cannot resolve.
 *
 * The tool registry attaches the structured `{ name, code }` a caller reads as
 * `result.error.info.code` ONLY to a `HarnessError`; any other error is still
 * materialized as a failure, just without the code.
 * @returns the class, or undefined when this deployment cannot resolve it.
 */
function harnessErrorClass() {
  if (harnessState.tried) return harnessState.error;
  harnessState.tried = true;
  try {
    const resolved = requireFromBases('@deepseek-ai/dsh-llm');
    if (resolved.ok) {
      const candidate = resolved.module?.HarnessError ?? resolved.module?.default?.HarnessError;
      if (typeof candidate === 'function') harnessState.error = candidate;
    }
  } catch {
    // A deployment without the runtime still gets the message below.
  }
  return harnessState.error;
}

/** One error carrying a stable code, like the delegation module's errors. */
function imageError(message, code) {
  const HarnessError = harnessErrorClass();
  const error = HarnessError === undefined ? new Error(message) : new HarnessError(message, code);
  error.name = 'FrugalImageBridgeError';
  error.code = code;
  return error;
}

/**
 * The attachment media type implied by one path's extension.
 * @param path - any path-like string.
 * @returns the declared media type, or undefined when the extension is unsupported.
 */
export function imageMediaTypeOfPath(path) {
  if (typeof path !== 'string') return undefined;
  const match = /\.([A-Za-z0-9]+)$/.exec(path.trim());
  if (match === null) return undefined;
  return MEDIA_TYPES[`.${match[1].toLowerCase()}`];
}

/** The durable reference fields kept in a record: identity plus display facts. */
function refOf(ref) {
  return {
    attachmentId: String(ref?.attachmentId ?? ''),
    mediaType: ref?.mediaType,
    bytes: ref?.bytes,
    width: ref?.width,
    height: ref?.height,
    ...ref?.name === undefined ? {} : { name: String(ref.name) },
  };
}

/**
 * Rebuild one durable image reference from a persisted record.
 *
 * The five identity fields are what the prompt-content admission path
 * produces; `originalDimensions` is display metadata and is not replayed.
 * @param record - one stored delivery record.
 * @returns the durable reference to verify and render.
 */
export function referenceOfRecord(record) {
  const ref = record?.ref ?? {};
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...ref.name === undefined ? {} : { name: ref.name },
  };
}

/**
 * The model-facing image block for one verified reference.
 *
 * Built at render time from the verified reference, never from persisted bytes:
 * the block must cite what the attachment service just checked.
 * @param ref - verified durable reference.
 * @returns the native image content block.
 */
export function imageBlockOf(ref) {
  return { type: 'image', attachment: refOf(ref) };
}

/** A store whose records live in this process only (tests, disabled persistence). */
export function createMemoryStore() {
  /** @type {Map<string, object[]>} */
  const deliveries = new Map();
  const keyOf = (parent, child) => `${parent}\u0000${child}`;
  return {
    kind: 'memory',
    async appendDelivery(entry, limits) {
      const key = keyOf(entry.parent, entry.child);
      const kept = [...(deliveries.get(key) ?? []), ...entry.records];
      deliveries.set(key, kept.slice(-limits.maxRecordsPerChild));
      return entry.records;
    },
    async listDeliveries(query) {
      return [...(deliveries.get(keyOf(query.parent, query.child)) ?? [])];
    },
    async markRead(query, ids) {
      const wanted = new Set(ids);
      let changed = 0;
      for (const record of deliveries.get(keyOf(query.parent, query.child)) ?? []) {
        if (wanted.has(record.image_id) && record.read_at === undefined) {
          record.read_at = query.time;
          changed += 1;
        }
      }
      return changed;
    },
  };
}

/** One filename-safe, collision-free leaf name for a child id. */
function storeLeaf(childId) {
  const digest = createHash('sha256').update(String(childId)).digest('hex').slice(0, 16);
  const readable = String(childId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 48);
  return `${readable}-${digest}.json`;
}

/**
 * A JSON store: one file per (parent, child), written atomically.
 *
 * `dir` is the caller's duty and must be an ABSOLUTE task-specific directory
 * (e.g. `<DSH_HOME>/frugal-orchestrator/image-deliveries`). A relative path is
 * refused outright, so this can never start writing inside a project checkout;
 * a host storage service is always preferable when one is already mounted.
 * @param options - see the individual fields.
 * @param options.dir - absolute directory owning this bridge's records.
 * @returns the store seam used by the two tools.
 * @throws when `dir` is not an absolute path.
 */
export function createFileStore(options) {
  const dir = options?.dir;
  if (typeof dir !== 'string' || !isAbsolute(dir)) {
    throw imageError(
      `${DELIVER_TOOL_NAME}: a file store needs an ABSOLUTE task-specific directory (got ${JSON.stringify(dir)}); `
      + 'never point it at a project or user directory',
      'IMAGE-STORE-DIR',
    );
  }
  const fileOf = (child) => join(dir, storeLeaf(child));
  const readOne = async (child) => {
    try {
      const parsed = JSON.parse(await readFileDefault(fileOf(child), 'utf8'));
      return Array.isArray(parsed?.records) ? parsed.records : undefined;
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const writeOne = async (parent, child, records) => {
    await mkdir(dir, { recursive: true });
    const target = fileOf(child);
    const staged = `${target}.${process.pid}.tmp`;
    await writeFile(staged, `${JSON.stringify({ version: 1, parent, child, records }, null, 2)}\n`, 'utf8');
    await rename(staged, target);
  };
  return {
    kind: 'file',
    dir,
    async appendDelivery(entry, limits) {
      const current = await readOne(entry.child);
      const kept = [...(current ?? []), ...entry.records].slice(-limits.maxRecordsPerChild);
      await writeOne(entry.parent, entry.child, kept);
      return entry.records;
    },
    async listDeliveries(query) {
      return (await readOne(query.child)) ?? [];
    },
    async markRead(query, ids) {
      const current = await readOne(query.child);
      if (current === undefined) return 0;
      const wanted = new Set(ids);
      let changed = 0;
      for (const record of current) {
        if (wanted.has(record.image_id) && record.read_at === undefined) {
          record.read_at = query.time;
          changed += 1;
        }
      }
      if (changed > 0) await writeOne(query.parent, query.child, current);
      return changed;
    },
  };
}

/**
 * Normalise the caller-supplied limit overrides.
 * @param overrides - partial overrides.
 * @returns the complete limit set.
 * @throws when one override is not a positive safe integer.
 */
function resolveLimits(overrides) {
  const limits = { ...DEFAULT_IMAGE_BRIDGE_LIMITS, ...(overrides ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw imageError(`image bridge limit ${name} must be a positive safe integer`, 'IMAGE-LIMITS');
    }
  }
  return limits;
}

/**
 * Read one source file as bytes, with the size bound applied before commit.
 * @param readFile - the injected reader.
 * @param path - the absolute source path.
 * @param limits - the resolved limits.
 * @returns `{ ok: true, data, mediaType }` or `{ ok: false, reason }`.
 */
async function readSource(readFile, path, limits) {
  if (typeof path !== 'string' || path.trim().length === 0) return { ok: false, reason: 'empty path' };
  if (path.includes('\u0000')) return { ok: false, reason: 'path contains a NUL byte' };
  if (!isAbsolute(path)) {
    return { ok: false, reason: 'the path is not absolute; pass an absolute path to the image file' };
  }
  const mediaType = imageMediaTypeOfPath(path);
  if (mediaType === undefined) {
    return { ok: false, reason: `unsupported image extension (allowed: ${Object.keys(MEDIA_TYPES).join(', ')})` };
  }
  let data;
  try {
    data = await readFile(path);
  } catch (error) {
    return { ok: false, reason: `the file could not be read (${describeThrown(error)})` };
  }
  if (!(data instanceof Uint8Array)) return { ok: false, reason: 'the reader returned no bytes' };
  if (data.byteLength === 0) return { ok: false, reason: 'the file is empty' };
  if (data.byteLength > limits.maxImageBytes) {
    return { ok: false, reason: `${data.byteLength} bytes exceeds the per-image limit of ${limits.maxImageBytes}` };
  }
  return { ok: true, data, mediaType };
}

/** The leaf name shown for an attachment: the file name, never a full path. */
function leafName(path) {
  const parts = String(path).split(/[\\/]+/);
  return parts[parts.length - 1] || undefined;
}

/** The newest non-empty note among records, if any. */
function newestNote(records) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const note = records[index]?.note;
    if (typeof note === 'string' && note.length > 0) return note;
  }
  return undefined;
}

/** The session id recorded with the newest delivery, if any. */
function newestSession(records) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const session = records[index]?.session;
    if (typeof session === 'string' && session.length > 0) return session;
  }
  return '';
}

/**
 * Build the one tool definition this installation owns.
 *
 * The identity callbacks are the INTEGRATION SEAM and the only place ownership
 * is decided: this module never inspects the agent registry, the Team
 * membership, or the child catalog itself.
 *
 * @param options - see the individual fields.
 * @param options.agent - the agent this installation belongs to.
 * @param options.role - `'worker'` registers `deliver_images`, `'lead'` registers `read_delivered_images`.
 * @param options.defineTool - the official factory from `@deepseek-ai/dsh-tools`.
 * @param options.attachments - the live `ctx.attachments` service.
 * @param options.store - the persistence seam (memory, file, or a host-service adapter).
 * @param options.identity - ownership facts, all required and fail-closed:
 *   `mayDeliver(agent)` / `mayRead(agent)`, `idOf(agent)`, and either
 *   `parentIdOf(agent)` (worker: its delegating parent's id, which MUST equal
 *   the Lead's `idOf`) or `resolveTarget(caller, target)` (lead: returns
 *   `{ childId, parentId, sessionId?, taskId? }` for a direct child, else
 *   undefined; it is AWAITED, because the authoritative direct-child answer is
 *   the host's durable catalog/roster, not an in-process cache that a restart
 *   would empty). `sessionIdOf(agent)`, `taskIdOf(agent)`, and `now()` are optional.
 * @param options.readFile - `(path) => Promise<Uint8Array>`; defaults to `node:fs/promises`.
 * @param options.limits - partial limit overrides.
 * @param options.note - diagnostic sink `(line) => void`.
 * @returns the definitions, keyed by tool name.
 * @throws when a required seam is missing.
 */
export function buildImageTools(options) {
  const {
    agent, role, defineTool, attachments, store, identity, note,
  } = options ?? {};
  const roleName = role === 'lead' ? 'lead' : 'worker';
  if (typeof defineTool !== 'function') {
    throw imageError(`${IMAGE_TOOL_NAMES.join(', ')}: the official defineTool factory was not supplied`, 'IMAGE-TOOLS-UNAVAILABLE');
  }
  if (attachments === undefined || attachments === null) {
    throw imageError('the attachment service is unavailable, so no image can be saved or verified', 'IMAGE-TOOLS-UNAVAILABLE');
  }
  if (store === undefined || typeof store.appendDelivery !== 'function' || typeof store.listDeliveries !== 'function') {
    throw imageError('the image bridge store seam is missing appendDelivery()/listDeliveries()', 'IMAGE-TOOLS-UNAVAILABLE');
  }
  const required = roleName === 'worker'
    ? ['mayDeliver', 'idOf', 'parentIdOf']
    : ['mayRead', 'idOf', 'resolveTarget'];
  for (const method of required) {
    if (typeof identity?.[method] !== 'function') {
      throw imageError(
        `identity.${method}() is required: ownership must be decided by the integration, not guessed here`,
        'IMAGE-TOOLS-UNAVAILABLE',
      );
    }
  }
  const limits = resolveLimits(options.limits);
  const readFile = typeof options.readFile === 'function' ? options.readFile : readFileDefault;
  const now = typeof identity.now === 'function' ? identity.now : () => Date.now();
  const log = typeof note === 'function' ? note : () => {};

  /** The calling agent, checked to be this installation's own agent. */
  const requireCaller = (exec, toolName) => {
    const caller = exec?.agent;
    if (caller === undefined || caller === null) {
      throw imageError(`${toolName}: this call needs a calling agent (exec.agent was undefined)`, 'IMAGE-NO-CALLER');
    }
    if (caller !== agent) {
      throw imageError(
        `${toolName}: this tool instance belongs to one agent's own tool layer and cannot act for another agent`,
        'IMAGE-FOREIGN-CALLER',
      );
    }
    return caller;
  };

  const tools = {};

  if (roleName === 'worker') {
    tools[DELIVER_TOOL_NAME] = defineTool({
      name: DELIVER_TOOL_NAME,
      description: 'Hand one or more images you produced (files on disk) to your Lead. '
        + 'Pass ABSOLUTE paths; their bytes are imported into the durable attachment store and the Lead reads them with '
        + `${READ_TOOL_NAME}. PNG/JPEG/WebP/GIF only. Use the short \`note\` when the Lead has to know which image is which; `
        + 'never paste base64 into a message.',
      parameters: {
        paths: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: 'Absolute paths of the image files to deliver (the files stay where they are; their bytes are imported).',
        },
        note: {
          type: 'string',
          description: 'Optional one-line description of what these images show, shown to the Lead.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            delivered: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  image_id: { type: 'string', required: true },
                  media_type: { type: 'string', required: true },
                  bytes: { type: 'integer', required: true },
                  width: { type: 'integer', required: true },
                  height: { type: 'integer', required: true },
                },
              },
            },
            failed: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  reason: { type: 'string', required: true },
                },
              },
            },
            count: { type: 'integer', required: true },
            child: { type: 'string', required: true },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const lines = [`delivered ${value.count} image(s) for ${value.child}; the Lead reads them with `
            + `${READ_TOOL_NAME}({ target: "${value.child}" }).`];
          for (const entry of value.delivered) {
            lines.push(`- ${entry.path} -> ${entry.image_id} (${entry.media_type}, ${entry.width}x${entry.height}px, ${entry.bytes} bytes)`);
          }
          for (const entry of value.failed) lines.push(`- SKIPPED ${entry.path}: ${entry.reason}`);
          if (value.note !== undefined) lines.push(`note: ${value.note}`);
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const caller = requireCaller(exec, DELIVER_TOOL_NAME);
        if (identity.mayDeliver(caller) !== true) {
          throw imageError(
            `${DELIVER_TOOL_NAME}: only an agent that does the work (a delegated child or a Team teammate) may deliver images`,
            'IMAGE-NOT-A-WORKER',
          );
        }
        const rawPaths = args?.paths;
        if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
          throw imageError(`${DELIVER_TOOL_NAME}: \`paths\` must be a non-empty array of image file paths`, 'IMAGE-BAD-ARGS');
        }
        if (rawPaths.length > limits.maxPathsPerCall) {
          throw imageError(
            `${DELIVER_TOOL_NAME}: at most ${limits.maxPathsPerCall} paths per call (got ${rawPaths.length})`,
            'IMAGE-TOO-MANY-PATHS',
          );
        }
        const shortNote = typeof args?.note === 'string' ? args.note.trim().slice(0, 200) : '';
        const child = String(identity.idOf(caller) ?? '<no-id>');
        const parent = String(identity.parentIdOf(caller) ?? '<no-parent>');
        const session = String(identity.sessionIdOf?.(caller) ?? caller?.session?.id ?? child);
        const task = identity.taskIdOf?.(caller);

        const delivered = [];
        const failed = [];
        const records = [];
        const seen = new Set();
        let totalBytes = 0;
        for (const rawPath of rawPaths) {
          const path = typeof rawPath === 'string' ? rawPath.trim() : '';
          if (path.length > 0 && seen.has(path)) {
            failed.push({ path, reason: 'duplicate path in this call' });
            continue;
          }
          if (path.length > 0) seen.add(path);
          const source = await readSource(readFile, path, limits);
          if (!source.ok) {
            failed.push({ path: path.length === 0 ? '<empty>' : path, reason: source.reason });
            continue;
          }
          if (delivered.length >= limits.maxImagesPerDelivery) {
            failed.push({ path, reason: `this call already delivered ${limits.maxImagesPerDelivery} image(s)` });
            continue;
          }
          if (totalBytes + source.data.byteLength > limits.maxDeliveryBytes) {
            failed.push({ path, reason: `adding it would exceed the per-delivery byte limit of ${limits.maxDeliveryBytes}` });
            continue;
          }
          let ref;
          try {
            ref = await attachments.saveImage({ data: source.data, mediaType: source.mediaType, name: leafName(path) });
          } catch (error) {
            failed.push({ path, reason: `the attachment service refused it (${describeThrown(error)})` });
            continue;
          }
          if (typeof ref?.attachmentId !== 'string' || ref.attachmentId.length === 0) {
            failed.push({ path, reason: 'the attachment service returned no durable reference' });
            continue;
          }
          totalBytes += source.data.byteLength;
          delivered.push({
            path,
            image_id: ref.attachmentId,
            media_type: String(ref.mediaType ?? source.mediaType),
            bytes: Number(ref.bytes ?? source.data.byteLength),
            width: Number(ref.width ?? 0),
            height: Number(ref.height ?? 0),
          });
          records.push({
            image_id: ref.attachmentId,
            ref: refOf(ref),
            parent,
            child,
            session,
            ...task === undefined ? {} : { task: String(task) },
            ...shortNote.length === 0 ? {} : { note: shortNote },
            time: new Date(now()).toISOString(),
          });
        }
        if (records.length > 0) {
          await store.appendDelivery({ parent, child, session, note: shortNote, records }, limits);
        }
        log(`${DELIVER_TOOL_NAME} child=${child.slice(0, 8)} delivered=${delivered.length} failed=${failed.length}`);
        return {
          delivered,
          failed,
          count: delivered.length,
          child,
          ...shortNote.length === 0 ? {} : { note: shortNote },
        };
      },
    });
  } else {
    tools[READ_TOOL_NAME] = defineTool({
      name: READ_TOOL_NAME,
      description: 'Read the images one of your direct reports explicitly delivered with '
        + `${DELIVER_TOOL_NAME}. \`target\` is that child's id, or its Team member name. Each verified image is `
        + 'returned as a real image block; deliveries you already read are skipped unless `include_read` is true. '
        + 'Nothing else from the child\'s session is read.',
      parameters: {
        target: {
          type: 'string',
          required: true,
          description: 'The direct child (delegated subagent id, or Team member target) whose deliveries you want.',
        },
        include_read: {
          type: 'boolean',
          description: 'Also re-render deliveries this Lead already read. Defaults to false.',
        },
        task_id: {
          type: 'string',
          description: 'Optional: only deliveries recorded for this task id.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            target: { type: 'string', required: true },
            child: { type: 'string', required: true },
            session: { type: 'string', required: true },
            images: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  image_id: { type: 'string', required: true },
                  media_type: { type: 'string', required: true },
                  bytes: { type: 'integer', required: true },
                  width: { type: 'integer', required: true },
                  height: { type: 'integer', required: true },
                  time: { type: 'string', required: true },
                  name: { type: 'string' },
                },
              },
            },
            missing: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  image_id: { type: 'string', required: true },
                  reason: { type: 'string', required: true },
                },
              },
            },
            skipped_read: { type: 'integer', required: true },
            count: { type: 'integer', required: true },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const blocks = [];
          const lines = [`${value.count} new image(s) from ${value.target} (${value.child}).`];
          if (value.skipped_read > 0) {
            lines.push(`${value.skipped_read} deliver${value.skipped_read === 1 ? 'y was' : 'ies were'} already read; `
              + 'pass include_read: true to see them again.');
          }
          for (const entry of value.images) {
            // The durable metadata is the record; the block itself is rebuilt
            // here so every rendered image carries a verified reference.
            lines.push(`- ${entry.image_id} (${entry.media_type}, ${entry.width}x${entry.height}px, ${entry.bytes} bytes, ${entry.time})`);
          }
          for (const entry of value.missing) {
            lines.push(`- UNAVAILABLE ${entry.image_id}: ${entry.reason} — ask the worker to deliver it again`);
          }
          if (value.note !== undefined) lines.push(`note: ${value.note}`);
          blocks.push({ type: 'text', text: lines.join('\n') });
          // The block is rebuilt from the DECLARED metadata so every rendered
          // image carries the reference the attachment service just verified.
          for (const entry of value.images) {
            blocks.push(imageBlockOf({
              attachmentId: entry.image_id,
              mediaType: entry.media_type,
              bytes: entry.bytes,
              width: entry.width,
              height: entry.height,
              ...entry.name === undefined ? {} : { name: entry.name },
            }));
          }
          return blocks;
        },
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const caller = requireCaller(exec, READ_TOOL_NAME);
        if (identity.mayRead(caller) !== true) {
          throw imageError(`${READ_TOOL_NAME}: only the Lead reads delivered images`, 'IMAGE-NOT-THE-LEAD');
        }
        const target = typeof args?.target === 'string' ? args.target.trim() : '';
        if (target.length === 0) throw imageError(`${READ_TOOL_NAME}: \`target\` must be a non-empty string`, 'IMAGE-BAD-ARGS');
        const callerId = String(identity.idOf(caller) ?? '<no-id>');
        // AWAITED on purpose: the authoritative "is this my direct child" answer
        // comes from the host's durable catalog (`subagents.listChildren`) or the
        // Team roster, both async. An in-process tracker would answer `undefined`
        // after a restart and make already-delivered images unreadable.
        const resolved = await identity.resolveTarget(caller, target);
        if (resolved === undefined || resolved === null || typeof resolved.childId !== 'string') {
          throw imageError(
            `${READ_TOOL_NAME}: "${target}" is not a direct child of yours, so its deliveries are out of reach`,
            'IMAGE-NOT-A-DIRECT-CHILD',
          );
        }
        const parent = String(resolved.parentId ?? '<no-parent>');
        if (parent !== callerId) {
          throw imageError(
            `${READ_TOOL_NAME}: "${target}" belongs to another Lead, not to you`,
            'IMAGE-NOT-YOUR-CHILD',
          );
        }
        const includeRead = args?.include_read === true;
        const wantedTask = typeof args?.task_id === 'string' && args.task_id.trim().length > 0 ? args.task_id.trim() : undefined;
        const all = await store.listDeliveries({ parent, child: resolved.childId });
        const selected = all.filter((record) => wantedTask === undefined || record.task === wantedTask);
        const fresh = includeRead ? selected : selected.filter((record) => record.read_at === undefined);
        // Oldest first and capped: one read can never inject more than the cap.
        const window = fresh.slice(0, limits.maxImagesPerRead);
        const images = [];
        const missing = [];
        const rendered = [];
        for (const record of window) {
          const ref = referenceOfRecord(record);
          let verified;
          try {
            const stored = await attachments.readImage(ref, exec?.signal);
            verified = refOf(stored?.ref ?? ref);
            if (typeof verified.attachmentId !== 'string' || verified.attachmentId.length === 0) {
              throw new Error('the attachment service verified no reference');
            }
          } catch (error) {
            // A broken or collected image is a diagnostic, never a failed step:
            // the Lead still gets the text answer and every other image.
            missing.push({ image_id: String(record.image_id), reason: describeThrown(error) });
            continue;
          }
          images.push({
            image_id: verified.attachmentId,
            media_type: String(verified.mediaType ?? ''),
            bytes: Number(verified.bytes ?? 0),
            width: Number(verified.width ?? 0),
            height: Number(verified.height ?? 0),
            time: String(record.time ?? ''),
            ...verified.name === undefined ? {} : { name: String(verified.name) },
          });
          rendered.push(String(record.image_id));
        }
        if (!includeRead && rendered.length > 0 && typeof store.markRead === 'function') {
          await store.markRead(
            { parent, child: resolved.childId, time: new Date(now()).toISOString() },
            rendered,
          );
        }
        const note = newestNote(window.length > 0 ? window : selected);
        const value = {
          target,
          child: resolved.childId,
          session: String(resolved.sessionId ?? newestSession(selected)),
          images,
          missing,
          skipped_read: Math.max(0, includeRead ? 0 : selected.length - fresh.length),
          count: images.length,
          ...note === undefined ? {} : { note },
        };
        log(`${READ_TOOL_NAME} child=${resolved.childId.slice(0, 8)} images=${images.length} missing=${missing.length}`);
        return value;
      },
    });
  }

  return tools;
}

/**
 * Install one side of the bridge on one governed agent.
 *
 * Mirrors `installDelegationTools`: a registration failure releases everything
 * this call installed, and the returned disposers are the caller's cleanup
 * contract for `loader/volatile-update` re-application.
 *
 * @param options - the same fields as {@link buildImageTools}, plus:
 * @param options.registry - the agent scope's tool registry (`agentCtx.tools`).
 * @param options.agentCtx - the agent's scoped context, used to resolve the attachment service when it is omitted.
 * @returns `{ disposers, definitions, store, limits }`.
 * @throws when the registry is missing or refuses the registration.
 */
export function installImageBridge(options) {
  const registry = options?.registry;
  if (registry === undefined || typeof registry.register !== 'function') {
    throw imageError('the agent scope exposes no tool registry with register()', 'IMAGE-TOOLS-UNAVAILABLE');
  }
  const attachments = options.attachments ?? serviceOf(options.agentCtx, 'attachments');
  const definitions = buildImageTools({ ...options, attachments });
  const names = options.role === 'lead' ? [READ_TOOL_NAME] : [DELIVER_TOOL_NAME];
  const disposers = [];
  try {
    for (const name of names) disposers.push(registry.register(definitions[name]));
  } catch (error) {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // A cleanup failure must not mask the registration failure below.
      }
    }
    throw imageError(
      `the tool registry refused ${names.join(', ')} (a same-layer registration with that name already exists, `
      + `or the registry rejected the definition): ${describeThrown(error)}`,
      'IMAGE-TOOLS-UNAVAILABLE',
    );
  }
  return {
    disposers, definitions, store: options.store, limits: resolveLimits(options.limits),
  };
}

/** Resolve one optional service from a scope, never throwing. */
function serviceOf(agentCtx, name) {
  try {
    const direct = agentCtx?.[name];
    if (direct !== undefined && direct !== null) return direct;
  } catch {
    // An accessor that throws counts as "not reachable from this scope".
  }
  try {
    return agentCtx?.get?.(name);
  } catch {
    return undefined;
  }
}
