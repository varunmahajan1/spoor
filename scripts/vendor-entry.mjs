/**
 * Entry point for `scripts/vendor.sh` — the surface a vendoring consumer gets.
 *
 * Exists because spoor is not on npm yet, and a host that installs from
 * package.json (Vercel, Netlify) cannot resolve a workspace package. Vendoring
 * one bundled file is the bridge until the packages are published.
 *
 * Deliberately excludes `@spoor/sinks/node`: the file sink imports node:fs and
 * would break an edge bundle, and it is useless on an ephemeral filesystem
 * anyway.
 */
export { createRecorder, record, preset, KillSwitch } from '@spoor/middleware'
export { s3Sink, webhookSink, memorySink, safeSink, multiSink } from '@spoor/sinks'
