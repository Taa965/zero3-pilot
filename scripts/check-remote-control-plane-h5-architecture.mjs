import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8')
}

function requireText(source, needle, message) {
  if (!source.includes(needle)) throw new Error(message)
}

function forbidText(source, needle, message) {
  if (source.includes(needle)) throw new Error(message)
}

const design = read('docs/H5_REMOTE_CONTROL_PLANE.md')
const cargo = read('apps/web/Cargo.toml')
const main = read('apps/web/src/main.rs')
const admission = read('apps/web/src/control_admission.rs')
const plane = read('apps/web/src/control_plane.rs')
const service = read('deployment/systemd/zero3-pilot.service')

requireText(design, 'Codex Thread / Turn / Item state on the Windows host remains the sole development execution authority.', 'H5 must preserve Codex as execution authority.')
requireText(design, 'An expired task is **not automatically reassigned to another node**.', 'H5 must document sticky no-automatic-failover behavior.')
requireText(design, 'event_sequence` must be strictly greater than the last accepted sequence, but it does **not** need to be contiguous.', 'H5 must document durable sequence gaps across fenced lease generations.')
requireText(cargo, 'chrono.workspace = true', 'H5 must reuse workspace time dependency.')
requireText(cargo, 'uuid.workspace = true', 'H5 must reuse workspace identity dependency.')
requireText(main, 'control_plane::RemoteControlRuntime::from_env()', 'zero3-web must initialize H5 control state explicitly.')
requireText(main, '.merge(remote)', 'zero3-web must mount the narrow H5 router beside /health.')
requireText(main, 'DefaultBodyLimit::max(', 'H5 remote HTTP surfaces must have an explicit request body limit.')
requireText(main, 'control_admission::validate_control_task_admission', 'H5 task creation must pass host-compatible admission before persistence.')
requireText(admission, 'MAX_REMOTE_CONTROL_BODY_BYTES: usize = 2 * 1024 * 1024', 'H5 task admission must match the 2 MiB Remote Host envelope boundary.')
requireText(admission, '64_000', 'H5 admission must enforce the Host objective limit.')
requireText(admission, '4096', 'H5 admission must enforce Host workspace/list item limits.')
requireText(admission, '"read_only" | "standard" | "elevated" | "full_control"', 'H5 admission must enforce the Host permission profile enum.')
requireText(admission, '(1..=32).contains(&max_turns)', 'H5 admission must enforce Host max_turns bounds.')
requireText(admission, '(30..=28_800).contains(&timeout_seconds)', 'H5 admission must enforce Host timeout bounds.')
requireText(plane, 'ZERO3_HOST_TOKEN_FILE', 'H5 host bearer secret must come from a file.')
requireText(plane, 'ZERO3_CONTROL_TOKEN_FILE', 'H5 control bearer secret must come from a separate file.')
requireText(plane, 'ZERO3_CONTROL_PLANE_DATA_DIR', 'H5 durable state root must be configurable.')
requireText(plane, '/var/lib/zero3-pilot/control-plane', 'H5 default durable state must remain inside the isolated Pilot data root.')
requireText(plane, 'file.sync_all()?', 'H5 committed record data must be fsynced before rename.')
requireText(plane, 'fs::rename(&temporary, path)', 'H5 state commit must use atomic rename.')
requireText(plane, 'File::open(parent)?.sync_all()?', 'H5 Unix state commit must fsync the parent directory.')
requireText(plane, 'sticky_node_id', 'H5 lease recovery must remain sticky to the original host.')
requireText(plane, '.checked_add(1)', 'H5 fencing token must monotonically advance with overflow protection.')
requireText(plane, 'StatusCode::GONE', 'H5 must explicitly fence stale/expired leases with a stale status understood by H4.')
requireText(plane, 'StatusCode::PRECONDITION_FAILED', 'H5 must explicitly reject stale fencing generations.')
requireText(plane, 'delivery_fingerprints', 'H5 must persist stable delivery idempotency evidence.')
requireText(plane, 'body.event_sequence <= record.last_event_sequence', 'H5 event sequence must be strictly monotonic for accepted mirrors.')
requireText(plane, '.route("/api/host/v1/tasks/lease", post(lease_task))', 'H5 host lease endpoint is missing.')
requireText(plane, '.route("/api/host/v1/tasks/:task_id/events", post(accept_event))', 'H5 host event endpoint is missing.')
requireText(plane, '.route("/api/control/v1/tasks", post(create_task).get(list_tasks))', 'H5 narrow control task endpoint is missing.')
requireText(service, 'ReadWritePaths=/opt/zero3-pilot-runtime /var/lib/zero3-pilot /var/log/zero3-pilot', 'H5 state root must stay inside existing systemd write allow-list.')

for (const source of [admission, plane]) {
  for (const forbidden of [
    'std::process::Command',
    'tokio::process',
    'powershell',
    'cmd.exe',
    'git2::',
    'simple-git',
    'Zero3CodexAppServer',
    'thread/start',
    'turn/start',
    'ipcRenderer',
    'ZERO3_PILOT_NODE_PORT'
  ]) {
    forbidText(source, forbidden, `H5 AWS control plane must not become an execution/kernel bypass: ${forbidden}`)
  }
}

forbidText(plane, 'authorization:', 'H5 durable state must never serialize bearer authorization material.')
forbidText(plane, 'host_token: String,\n    pub', 'H5 auth config must not be part of public serializable state.')

console.log('Zero3 Remote Control Plane H5 architecture guard passed: host-compatible admission -> durable task/node state -> sticky lease/fencing -> idempotent mirrors, with Codex remaining the sole execution kernel.')
