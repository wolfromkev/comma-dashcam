import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WEB_DIST = path.join(ROOT, "web-dist");
const LIST_PY = path.join(__dirname, "list-drives.py");

const HOST = process.env.COMMA_HOST || "comma";
const SSH_KEY = process.env.COMMA_SSH_KEY || path.join(process.env.HOME, ".ssh/id_ed25519");
const CONFIG_PATH = path.join(process.env.HOME, ".config/comma-dashcam.json");
const DEFAULT_DEST = process.env.COMMA_DEST || path.join(process.env.HOME, "Movies/comma");
const dirs = { dest: DEFAULT_DEST, raw: "", videos: "", thumbs: "" };

function setDestMemory(root) {
  dirs.dest = root;
  dirs.raw = path.join(root, "raw");
  dirs.videos = path.join(root, "videos");
  dirs.thumbs = path.join(root, "thumbs");
}

function readSavedDest() {
  try {
    const dest = JSON.parse(readFileSync(CONFIG_PATH, "utf8")).dest;
    if (typeof dest === "string" && dest.trim()) return path.resolve(dest.trim());
  } catch {
    /* default */
  }
  return DEFAULT_DEST;
}

setDestMemory(readSavedDest());

async function applyDest(next) {
  const resolved = path.resolve(String(next || "").trim());
  if (!resolved || resolved === "/") throw new Error("Choose a folder.");
  await mkdir(path.join(resolved, "raw"), { recursive: true });
  await mkdir(path.join(resolved, "videos"), { recursive: true });
  await mkdir(path.join(resolved, "thumbs"), { recursive: true });
  setDestMemory(resolved);
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify({ dest: resolved }, null, 2)}\n`);
  return dirs;
}
const REMOTE_PATH = "/data/media/0/realdata/";
const PORT = Number(process.env.PORT || 8787);
const RSYNC = existsSync("/opt/homebrew/bin/rsync") ? "/opt/homebrew/bin/rsync" : "rsync";
const FFMPEG = existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";
const ROUTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FIND_QCAMERA_PY = `
import os
root, rid = "/data/media/0/realdata", __RID__
cands = []
for name in os.listdir(root):
    parts = name.rsplit("--", 1)
    if len(parts) == 2 and parts[0] == rid and parts[1].isdigit():
        p = os.path.join(root, name, "qcamera.ts")
        if os.path.isfile(p):
            cands.append((int(parts[1]), p))
cands.sort()
print(cands[0][1] if cands else "")
`;

const thumbJobs = new Map();
let thumbActive = 0;
const thumbWaiters = [];

function withThumbLimit(fn) {
  return new Promise((resolve, reject) => {
    const start = () => {
      thumbActive += 1;
      fn().then(resolve, reject).finally(() => {
        thumbActive -= 1;
        const next = thumbWaiters.shift();
        if (next) next();
      });
    };
    if (thumbActive >= 3) thumbWaiters.push(start);
    else start();
  });
}

function assertRouteId(id) {
  if (typeof id !== "string" || !ROUTE_RE.test(id) || id.includes("..") || id.includes("/")) {
    throw new Error(`Invalid drive id: ${id}`);
  }
  return id;
}

function localQcamera(id) {
  if (!existsSync(dirs.raw)) return null;
  const names = [];
  for (const name of readdirSync(dirs.raw)) {
    if (!name.startsWith(`${id}--`)) continue;
    const file = path.join(dirs.raw, name, "qcamera.ts");
    if (existsSync(file)) names.push(file);
  }
  names.sort();
  return names[0] || null;
}

function ffmpegFrame(inputPath, dest, stdinStream) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=320:-2",
      "-q:v",
      "5",
      dest,
    ];
    const child = spawn(FFMPEG, args);
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && existsSync(dest)) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg exited ${code}`));
    });
    if (stdinStream) stdinStream.pipe(child.stdin);
  });
}

async function remoteQcameraPath(id) {
  const { stdout } = await ssh("python3 -", FIND_QCAMERA_PY.replace("__RID__", JSON.stringify(id)));
  return stdout.trim() || null;
}

async function buildThumb(id) {
  await mkdir(dirs.thumbs, { recursive: true });
  const dest = path.join(dirs.thumbs, `${id}.jpg`);
  const local = localQcamera(id);
  if (local) {
    await ffmpegFrame(local, dest);
    return dest;
  }
  const remote = await remoteQcameraPath(id);
  if (!remote) throw new Error("no preview");
  const sshp = spawn("ssh", [...sshFlags(), HOST, `cat -- ${JSON.stringify(remote)}`]);
  await ffmpegFrame("pipe:0", dest, sshp.stdout);
  return dest;
}

function ensureThumb(id) {
  const dest = path.join(dirs.thumbs, `${id}.jpg`);
  if (existsSync(dest)) return Promise.resolve(dest);
  const existing = thumbJobs.get(id);
  if (existing) return existing;
  const jobp = withThumbLimit(() => buildThumb(id)).finally(() => thumbJobs.delete(id));
  thumbJobs.set(id, jobp);
  return jobp;
}

let job = null;

function sshFlags() {
  return [
    "-i",
    SSH_KEY,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=6",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
}

function run(cmd, args, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `${cmd} exited ${code}`));
    });
    if (stdin != null) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

function ssh(remoteCmd, stdin) {
  return run("ssh", [...sshFlags(), HOST, remoteCmd], stdin);
}

async function listDrives(root, viaSsh) {
  const script = await readFile(LIST_PY, "utf8");
  if (viaSsh) {
    const { stdout } = await ssh("python3 -", script);
    return JSON.parse(stdout.trim() || "[]");
  }
  if (!existsSync(root)) return [];
  const { stdout } = await run("python3", [LIST_PY, root]);
  return JSON.parse(stdout.trim() || "[]");
}

function parseDfK(line) {
  const parts = String(line || "").trim().split(/\s+/);
  if (parts.length < 4) return null;
  return {
    totalBytes: Number(parts[1]) * 1024,
    usedBytes: Number(parts[2]) * 1024,
    freeBytes: Number(parts[3]) * 1024,
  };
}

async function deviceStatus() {
  try {
    const { stdout } = await ssh("hostname; df -k /data/media/0 | tail -1; date +%s");
    const [hostname, dfLine, now] = stdout.trim().split("\n");
    return { online: true, hostname, disk: parseDfK(dfLine), now: Number(now) };
  } catch (err) {
    return {
      online: false,
      hostname: HOST,
      disk: null,
      now: Math.floor(Date.now() / 1000),
      error: err.message,
    };
  }
}

async function destDisk() {
  const { stdout } = await run("df", ["-k", dirs.dest]);
  return parseDfK(stdout.trim().split("\n").pop());
}

function mergeDrives(remote, local, now) {
  const map = new Map();
  for (const d of remote) {
    map.set(d.id, { ...d, onDevice: true, onMac: false, localBytes: 0, localSegments: 0 });
  }
  for (const d of local) {
    const cur = map.get(d.id);
    if (cur) {
      cur.onMac = true;
      cur.localBytes = d.bytes;
      cur.localSegments = d.segments;
    } else {
      map.set(d.id, {
        ...d,
        onDevice: false,
        onMac: true,
        localBytes: d.bytes,
        localSegments: d.segments,
      });
    }
  }
  return [...map.values()]
    .map((d) => ({
      ...d,
      remainingBytes: Math.max(0, (d.onDevice ? d.bytes : 0) - (d.localBytes || 0)),
      recording: Boolean(d.onDevice && d.updatedAt && now - d.updatedAt < 120),
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || b.id.localeCompare(a.id));
}

function assertRoutes(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("Select at least one drive.");
  for (const id of ids) {
    if (typeof id !== "string" || !ROUTE_RE.test(id) || id.includes("..") || id.includes("/")) {
      throw new Error(`Invalid drive id: ${id}`);
    }
  }
  return ids;
}

function send(res, event) {
  res.write(`${JSON.stringify(event)}\n`);
}

function startTracked(cmd, args, { onLine, signal, stdin }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    job.child = child;
    let buf = "";
    const handle = (chunk) => {
      buf += chunk.toString();
      const parts = buf.split(/\r|\n/);
      buf = parts.pop() || "";
      for (const line of parts) {
        if (line.trim()) onLine(line);
      }
    };
    child.stdout.on("data", handle);
    child.stderr.on("data", handle);
    const kill = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", kill);
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", kill);
      if (code === 0) resolve();
      else if (signal?.aborted) reject(new Error("Canceled"));
      else reject(new Error(`${path.basename(cmd)} exited ${code}`));
    });
    if (stdin != null) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

function parseRsyncLine(line) {
  const m = line.match(/([\d,.]+(?:[KMG])?)\s+(\d+)%\s+(\S+)/);
  if (!m) return null;
  return { bytes: m[1], percent: Number(m[2]), speed: m[3] };
}

async function transfer({ ids, mode, stitch }, res, signal) {
  await mkdir(dirs.raw, { recursive: true });
  await mkdir(dirs.videos, { recursive: true });

  const includes = ["--include=*/"];
  for (const id of ids) {
    includes.push(`--include=${id}--*/`, `--include=${id}--*/*`);
  }
  includes.push("--exclude=*");

  send(res, {
    type: "phase",
    phase: "copy",
    message: `Copying ${ids.length} drive${ids.length === 1 ? "" : "s"} to this Mac…`,
  });

  await startTracked(
    RSYNC,
    [
      "-a",
      "--partial",
      "--info=progress2",
      "--prune-empty-dirs",
      ...includes,
      "-e",
      `ssh ${sshFlags().join(" ")}`,
      `${HOST}:${REMOTE_PATH}`,
      `${dirs.raw}/`,
    ],
    {
      signal,
      onLine: (line) => {
        const p = parseRsyncLine(line);
        if (p) send(res, { type: "progress", ...p });
        else send(res, { type: "log", line });
      },
    },
  );

  if (mode === "move") {
    send(res, { type: "phase", phase: "delete", message: "Removing selected drives from the comma…" });
    await startTracked("ssh", [...sshFlags(), HOST, "python3", "-"], {
      signal,
      stdin: `
import os, shutil
root = "/data/media/0/realdata"
ids = set(${JSON.stringify(ids)})
for name in os.listdir(root):
    parts = name.rsplit("--", 1)
    if len(parts) == 2 and parts[1].isdigit() and parts[0] in ids:
        shutil.rmtree(os.path.join(root, name), ignore_errors=True)
`,
      onLine: () => {},
    });
  }

  if (stitch) {
    send(res, { type: "phase", phase: "stitch", message: "Building MP4s…" });
    await startTracked(path.join(ROOT, "comma-dashcam"), ["stitch"], {
      signal,
      onLine: (line) => send(res, { type: "log", line }),
    });
  }

  send(res, { type: "done", message: "Finished." });
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.post("/api/dest", async (req, res) => {
  try {
    const dest = await applyDest(req.body?.path);
    res.json(dest);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/dest/pick", async (_req, res) => {
  try {
    const { stdout } = await run("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Choose where to save dashcam footage")',
    ]);
    const dest = await applyDest(stdout.trim());
    res.json(dest);
  } catch (err) {
    const canceled = /User canceled|(-128)/i.test(err.message);
    res.status(400).json({ error: canceled ? "Canceled" : err.message });
  }
});

app.get("/api/thumb/:id", async (req, res) => {
  try {
    const id = assertRouteId(req.params.id);
    const file = await ensureThumb(id);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("jpg").sendFile(file);
  } catch {
    res.status(404).end();
  }
});

app.get("/api/library", async (_req, res) => {
  try {
    const device = await deviceStatus();
    const [disk, remote, local] = await Promise.all([
      destDisk(),
      device.online ? listDrives(REMOTE_PATH, true) : Promise.resolve([]),
      listDrives(dirs.raw, false),
    ]);
    res.json({
      device,
      dest: { path: dirs.dest, raw: dirs.raw, videos: dirs.videos, disk },
      drives: mergeDrives(remote, local, device.now || Math.floor(Date.now() / 1000)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/transfer", async (req, res) => {
  if (job) {
    res.status(409).json({ error: "A transfer is already running." });
    return;
  }
  let ids;
  try {
    ids = assertRoutes(req.body?.ids);
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders?.();

  const ac = new AbortController();
  let finished = false;
  req.on("close", () => {
    if (!finished) ac.abort();
  });
  job = { child: null };
  try {
    await transfer(
      { ids, mode: req.body?.mode === "move" ? "move" : "copy", stitch: Boolean(req.body?.stitch) },
      res,
      ac.signal,
    );
    finished = true;
  } catch (err) {
    finished = true;
    if (!res.writableEnded) send(res, { type: "error", message: err.message });
  } finally {
    job = null;
    if (!res.writableEnded) res.end();
  }
});

if (process.env.NODE_ENV === "production" && existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get("*", (_req, res) => res.sendFile(path.join(WEB_DIST, "index.html")));
}

app.listen(PORT, "127.0.0.1", () => {
  console.log(`comma-dashcam api  http://127.0.0.1:${PORT}`);
});
