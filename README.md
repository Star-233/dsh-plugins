# dsh-plugins

Two [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH) plugin bundles that make
long agent sessions cheaper and more predictable: a **context budget / compaction policy** and a
**frugal orchestrator** that keeps the expensive model on orchestration while workers run the cheap one.

| Package | Version | What it does |
| --- | --- | --- |
| [`@nu11dev/dsh-compaction-policy`](plugins/dsh-compaction-policy/README.md) | 0.1.0 | Decouples the compaction **threshold** from the per-request **output cap**, and makes the preset's compaction engine actually reachable through a `bridge` row. |
| [`@nu11dev/dsh-frugal-orchestrator`](plugins/dsh-frugal-orchestrator/README.md) | 0.4.0 | Session-scoped Subagent / native Agent Teams mode, member and concurrency limits, per-agent model routing, diagnostics, and the `deliver_images` bridge that lets a worker hand images back to the Lead. |

Both halves are hand-written Cordis plugin bundles: an ES-module host half and a
`window.__ModuleLoader__.load` browser half. There is no build step — what you read is what DSH loads.

## Requirements

- **DSH 0.2.0-rc.2** (verified against it; the host half needs `agent/pre-step`, `agent/request`,
  `agent/request-error`, `agentPresets.serviceFor`, `tokenMeter`, `sessionQuery`, and the compaction
  services).
- **Node `^22.19.0 || >=24.0.0`** (the host half uses `require(esm)` and top-level `await`).
- A DSH profile to install into — the default is `~/.dsh/profiles/web`.

## Install

```bash
# the orchestrator, plus the policy package its preset bridges to
dsh plugin --profile web add @nu11dev/dsh-frugal-orchestrator @nu11dev/dsh-compaction-policy

# or the policy package on its own
dsh plugin --profile web add @nu11dev/dsh-compaction-policy
```

`dsh plugin add` writes the packages into the profile's `dependencies` and `dsh.profile.bundles`,
because each package declares `dsh.bundle.patch`. **Restart DSH afterwards** — the bundle list is read
at startup. Plugin *settings* are volatile and apply to the next request without a restart.

### The two packages are coupled in one direction

`@nu11dev/dsh-frugal-orchestrator`'s `frugal` preset carries a row that imports
`@nu11dev/dsh-compaction-policy/bridge`, so **B requires A**:

- **B needs A.** Install B without A and the `frugal` preset is missing a row and fails to load. The
  bridge row is the preset's takeover switch: delete it and the preset falls back to the host's
  built-in compaction.
- **A does not need B.** The policy package works on its own for any preset you add a bridge row to.

The dependency is declared as an **optional peer** in B's manifest, not as a hard `dependencies`
entry. Optional peers are not auto-installed, which keeps a `link:` development profile installable
before the package exists on the registry; the coupling itself is enforced at run time by the preset,
and by the install instructions above. Once both names are published you may switch B to a real
`dependencies` entry so one `add` pulls in the other.

### Where the cheap worker route comes from (the defaults deliberately pick none)

The orchestrator ships **no** provider/model defaults for its workers. `subagentProvider`,
`subagentModel` and `subagentReasoningEffort` are empty in the schema and in the bundled
`cordis.patch.yml`, and empty means **inherit the parent's route**: an all-empty route is passed as no
`agentOptions` override at all, and a partially filled one only overrides the half it names.

So on a fresh install the workers run on the *same* route as the Lead — nothing is silently routed to a
provider that may not exist in your profile. The cheap-execution benefit is opt-in: open the
**插件 panel → bundle `@nu11dev/dsh-frugal-orchestrator` → row `frugal-gate` → 配置** and set those
three worker fields to a cheap provider/model your profile really has (the fields accept a provider, a
model, and a thinking level; leave any of them blank to keep inheriting it). Settings are volatile, so
the change applies to the next request — no restart.

## Repository layout

```text
plugins/dsh-compaction-policy/    @nu11dev/dsh-compaction-policy
  index.js  bridge.js  client.js  lib/  cordis.patch.yml  *.test.mjs
plugins/dsh-frugal-orchestrator/  @nu11dev/dsh-frugal-orchestrator
  index.js  client.js  lib/  cordis.patch.yml  *.test.mjs
.github/workflows/ci.yml          tests on Node 24 against a pinned DSH runtime
.github/workflows/publish.yml     tag-triggered npm publish over OIDC trusted publishing
```

## Development

Each package is self-contained and has no runtime dependencies to install:

```bash
cd plugins/dsh-compaction-policy   # or plugins/dsh-frugal-orchestrator
npm test                           # offline; calls no paid model
```

The test harnesses resolve the *real* DSH runtime instead of stubbing it, so they need two paths:

- `DSH_TOOLS_DIR` — the `@deepseek-ai` directory that holds the runtime packages
  (`dsh-session`, `dsh-llm`, `dsh-compaction`, …). Defaults to the global npm install on Windows.
- `DSH_PROFILE_DIR` — a profile directory whose `node_modules` can resolve
  `@deepseek-ai/schemastery` (the host half builds its volatile `Config` from it).

The reproducible CI recipe, which is exactly what `.github/workflows/ci.yml` runs:

```bash
mkdir -p .ci-runtime && cd .ci-runtime
# npm derives a package name from the directory, and rejects the leading dot,
# so write the scratch manifest instead of `npm init -y`.
printf '{"name":"dsh-ci-runtime","private":true}\n' > package.json
npm install --no-audit --no-fund @deepseek-ai/dsh@0.2.0-rc.2
export DSH_TOOLS_DIR="$PWD/node_modules/@deepseek-ai"   # npm hoists the runtime here
export DSH_PROFILE_DIR="$PWD"
cd ../plugins/dsh-compaction-policy && npm test
```

`npm test` and `npm run verify:profile` are **repository-checkout-only**: the published tarballs carry
just the runtime files listed in each `files` whitelist, so they contain neither the `*.test.mjs`
harnesses nor `verify-profile.mjs`. Install a package to *use* it; clone this repository to *test* it.

`npm run verify:profile` is **not** part of CI: it boots `dsh --dump-config` against a real profile and
asserts that the profile links this checkout, so it only means something on a machine that has both.

## Releasing

Releases are tag-driven and credential-free in CI:

1. Bump `version` in the package's `package.json` and commit it.
2. Push a tag named `<package>-v<version>` — `dsh-compaction-policy-v0.1.0` or
   `dsh-frugal-orchestrator-v0.4.0`. The tag prefix selects the package; the workflow refuses to
   publish when the tag does not name the version in `package.json`.
3. The workflow re-runs the tests, then publishes with provenance over **npm trusted publishing**
   (OIDC), so no long-lived npm token is stored in the repository.

Publishing needs one-time setup on npmjs.com that no workflow can do for itself (see
`.github/workflows/publish.yml` for the exact contract):

- one **trusted publisher** per package: organization/user `Star-233`, repository `dsh-plugins`,
  workflow filename `publish.yml`;
- after the 2026-09-03 npm change, a new trusted-publisher entry allows staged publishing only, so
  **enable `npm publish` explicitly** on it;
- if you later attach a GitHub *environment* to the publish job, that environment must be recorded in
  the same npm configuration.

## License

[MIT](LICENSE).
