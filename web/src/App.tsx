import { useCallback, useEffect, useMemo, useState } from "react";

type Disk = { totalBytes: number; usedBytes: number; freeBytes: number };

type Drive = {
  id: string;
  segments: number;
  firstSegment: number;
  lastSegment: number;
  gaps: boolean;
  bytes: number;
  cameras: string[];
  startedAt: number;
  updatedAt: number;
  onDevice: boolean;
  onMac: boolean;
  localBytes: number;
  localSegments: number;
  remainingBytes: number;
  recording: boolean;
};

type Library = {
  device: { online: boolean; hostname: string; disk: Disk | null; error?: string };
  dest: { path: string; disk: Disk | null };
  drives: Drive[];
};

type Job = {
  phase: string;
  message: string;
  percent: number | null;
  speed: string | null;
  log: string[];
  error: string | null;
  done: boolean;
};

function fmtBytes(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function fmtWhen(ts: number) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Thumb({ id }: { id: string }) {
  const [ok, setOk] = useState(true);
  if (!ok) return <div className="thumb ph" />;
  return (
    <div className="thumb">
      <img
        src={`/api/thumb/${encodeURIComponent(id)}`}
        alt=""
        loading="lazy"
        onError={() => setOk(false)}
      />
    </div>
  );
}

function DiskBar({ label, disk }: { label: string; disk: Disk | null }) {
  if (!disk) return <div className="disk">{label}: unknown</div>;
  const pct = Math.min(100, Math.round((disk.usedBytes / disk.totalBytes) * 100));
  return (
    <div className="disk">
      <div className="disk-top">
        <span>{label}</span>
        <span>
          {fmtBytes(disk.freeBytes)} free · {fmtBytes(disk.totalBytes)}
        </span>
      </div>
      <div className="bar">
        <div className={`bar-fill ${pct >= 90 ? "hot" : ""}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function App() {
  const [lib, setLib] = useState<Library | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"copy" | "move">("copy");
  const [stitch, setStitch] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [destDraft, setDestDraft] = useState("");
  const [picking, setPicking] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/library");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      setLib(data);
      setDestDraft(data.dest.path);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const drives = useMemo(() => {
    if (!lib) return [];
    const q = query.trim().toLowerCase();
    return lib.drives.filter((d) => {
      if (!q) return true;
      return (
        d.id.toLowerCase().includes(q) ||
        d.cameras.join(" ").includes(q) ||
        fmtWhen(d.startedAt).toLowerCase().includes(q)
      );
    });
  }, [lib, query]);

  const selectedDrives = useMemo(
    () => (lib ? lib.drives.filter((d) => selected.has(d.id)) : []),
    [lib, selected],
  );
  const remaining = selectedDrives.reduce((n, d) => n + d.remainingBytes, 0);
  const destFree = lib?.dest.disk?.freeBytes ?? 0;
  const wontFit = remaining > destFree && remaining > 0;

  async function saveDest(next: string) {
    const res = await fetch("/api/dest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: next }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not set folder");
    await refresh();
  }

  async function pickDest() {
    setPicking(true);
    try {
      const res = await fetch("/api/dest/pick", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 499 || data.error === "Canceled") return;
      if (!res.ok) throw new Error(data.error || "Could not pick folder");
      await refresh();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not pick folder");
    } finally {
      setPicking(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleVisible(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const d of drives) {
        if (on) next.add(d.id);
        else next.delete(d.id);
      }
      return next;
    });
  }

  async function startTransfer() {
    if (selectedDrives.length === 0 || busy) return;
    setBusy(true);
    setJob({
      phase: "copy",
      message: "Starting…",
      percent: 0,
      speed: null,
      log: [],
      error: null,
      done: false,
    });
    try {
      const res = await fetch("/api/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: selectedDrives.map((d) => d.id),
          mode,
          stitch,
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || res.statusText);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as {
            type: string;
            phase?: string;
            message?: string;
            percent?: number;
            speed?: string;
            line?: string;
          };
          setJob((cur) => {
            if (!cur) return cur;
            if (ev.type === "phase") {
              return { ...cur, phase: ev.phase || cur.phase, message: ev.message || cur.message, percent: ev.phase === "copy" ? cur.percent : null };
            }
            if (ev.type === "progress") {
              return { ...cur, percent: ev.percent ?? cur.percent, speed: ev.speed || cur.speed, message: ev.speed ? `${ev.percent}% · ${ev.speed}` : cur.message };
            }
            if (ev.type === "log") {
              return { ...cur, log: [...cur.log.slice(-40), ev.line || ""] };
            }
            if (ev.type === "error") {
              return { ...cur, error: ev.message || "Transfer failed", done: true };
            }
            if (ev.type === "done") {
              return { ...cur, done: true, percent: 100, message: ev.message || "Finished." };
            }
            return cur;
          });
        }
      }
      await refresh();
    } catch (err) {
      setJob((cur) => ({
        phase: cur?.phase || "copy",
        message: cur?.message || "",
        percent: cur?.percent ?? null,
        speed: cur?.speed ?? null,
        log: cur?.log || [],
        error: err instanceof Error ? err.message : "Transfer failed",
        done: true,
      }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header>
        <div>
          <h1>comma dashcam</h1>
          <p className="sub">
            {loading && !lib ? (
              "Connecting…"
            ) : lib?.device.online ? (
              <>
                <span className="dot ok" /> {lib.device.hostname} · local only
              </>
            ) : (
              <>
                <span className="dot off" /> Device offline{lib?.device.error ? ` · ${lib.device.error}` : ""}
              </>
            )}
          </p>
        </div>
        <button className="ghost" onClick={() => void refresh()} disabled={loading || busy}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      <section className="stats">
        <DiskBar label={lib?.device.hostname || "comma"} disk={lib?.device.disk ?? null} />
        <DiskBar label="This Mac" disk={lib?.dest.disk ?? null} />
        <div className="dest-row">
          <label className="dest-label" htmlFor="dest-path">
            Save videos here
          </label>
          <div className="dest-controls">
            <input
              id="dest-path"
              type="text"
              value={destDraft}
              onChange={(e) => setDestDraft(e.target.value)}
              spellCheck={false}
              disabled={busy || picking}
            />
            <button className="ghost" disabled={busy || picking} onClick={() => void pickDest()}>
              {picking ? "Picking…" : "Browse…"}
            </button>
            <button
              className="ghost"
              disabled={busy || picking || !destDraft || destDraft === lib?.dest.path}
              onClick={() => void saveDest(destDraft).catch((err) => setLoadError(err.message))}
            >
              Save
            </button>
          </div>
        </div>
      </section>

      {wontFit && (
        <div className="warn">
          Selected leftover footage is {fmtBytes(remaining)}, but this Mac only has {fmtBytes(destFree)} free.
          Select fewer drives or free some space.
        </div>
      )}

      {loadError && <div className="warn">{loadError}</div>}

      <div className="toolbar">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by id, camera, date"
        />
        <button className="ghost" onClick={() => toggleVisible(true)}>
          Select visible
        </button>
        <button className="ghost" onClick={() => setSelected(new Set())}>
          Clear
        </button>
        <span className="muted">
          {lib ? `${lib.drives.length} drives` : ""}
          {query ? ` · ${drives.length} shown` : ""}
        </span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="check" />
              <th className="thumb-col">Preview</th>
              <th>Recorded</th>
              <th>Drive</th>
              <th>Length</th>
              <th>Size</th>
              <th>Cameras</th>
              <th>Where</th>
            </tr>
          </thead>
          <tbody>
            {drives.map((d) => {
              const on = selected.has(d.id);
              const where = [
                d.onDevice ? "comma" : null,
                d.onMac ? "Mac" : null,
              ]
                .filter(Boolean)
                .join(" + ");
              return (
                <tr key={d.id} className={on ? "on" : ""} onClick={() => toggle(d.id)}>
                  <td className="check">
                    <input type="checkbox" checked={on} readOnly />
                  </td>
                  <td className="thumb-col">
                    <Thumb id={d.id} />
                  </td>
                  <td>
                    {fmtWhen(d.startedAt)}
                    {d.recording && <span className="pill rec">recording</span>}
                    {d.gaps && <span className="pill">gaps</span>}
                  </td>
                  <td className="mono">{d.id}</td>
                  <td>{d.segments} min</td>
                  <td>
                    {fmtBytes(d.bytes)}
                    {d.onMac && d.remainingBytes > 0 && (
                      <div className="tiny">{fmtBytes(d.remainingBytes)} left</div>
                    )}
                  </td>
                  <td>{d.cameras.join(", ") || "—"}</td>
                  <td>{where || "—"}</td>
                </tr>
              );
            })}
            {!loading && drives.length === 0 && (
              <tr>
                <td colSpan={8} className="empty">
                  No drives match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <footer>
        <div className="footer-left">
          <label>
            <input
              type="radio"
              name="mode"
              checked={mode === "copy"}
              onChange={() => setMode("copy")}
              disabled={busy}
            />
            Copy to Mac
          </label>
          <label>
            <input
              type="radio"
              name="mode"
              checked={mode === "move"}
              onChange={() => setMode("move")}
              disabled={busy}
            />
            Move (delete from comma after)
          </label>
          <label>
            <input type="checkbox" checked={stitch} onChange={(e) => setStitch(e.target.checked)} disabled={busy} />
            Also stitch MP4s
          </label>
          <div className="muted">
            {selectedDrives.length} selected · {fmtBytes(remaining)} to copy
          </div>
        </div>
        <button className="primary" disabled={busy || selectedDrives.length === 0 || wontFit} onClick={() => void startTransfer()}>
          {busy ? "Working…" : mode === "move" ? "Move selected" : "Copy selected"}
        </button>
      </footer>

      {job && (
        <section className={`job ${job.error ? "bad" : ""} ${job.done && !job.error ? "good" : ""}`}>
          <div className="job-top">
            <strong>{job.error || job.message}</strong>
            {job.percent != null && <span>{job.percent}%</span>}
          </div>
          <div className="bar tall">
            <div
              className={`bar-fill ${job.error ? "hot" : ""}`}
              style={{ width: `${job.percent ?? (job.done ? 100 : 8)}%` }}
            />
          </div>
          {job.log.length > 0 && <pre>{job.log.slice(-6).join("\n")}</pre>}
        </section>
      )}
    </div>
  );
}
