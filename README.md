# comma-dashcam

Pull road-camera footage off the comma over your home Wi‑Fi and stitch it into MP4s. Files stay on this Mac. Nothing is sent to connect.comma.ai.

The SSH host alias is `comma`.

## One-time setup

```bash
cd ~/Programming/comma-dashcam
COMMA_MDNS=comma-xxxxxx.local ./comma-dashcam setup
```

`comma-xxxxxx.local` is the name on the comma's Wi‑Fi screen. That writes the SSH host. Then:

1. Add this Mac’s SSH public key to GitHub → Settings → SSH keys.
2. On the comma: **Settings → Network → Advanced → SSH Keys → Add** and enter your GitHub username. If a username is already there, remove it and add it again so the device re-fetches keys.
3. Optional: turn off raw / route uploads in those same settings if you want footage to stay local only.

`setup` will tell you when login works.

## Web UI

Browse every drive, see sizes and disk space, then copy or move selected footage with a progress bar.

```bash
cd ~/Programming/comma-dashcam
npm install
npm run dev
```

Open http://127.0.0.1:5174. Set the save folder in the UI (Browse… or paste a path). This Mac only has a little free disk — select specific drives instead of everything.

## Everyday use (CLI)

Car on, comma on the same Wi‑Fi as this Mac:

```bash
./comma-dashcam sync
```

That downloads new `fcamera` (road) and `ecamera` (wide) segments, then writes playable MP4s.

| Command | What it does |
|---|---|
| `setup` | SSH host + login check |
| `status` | Device + local library |
| `pull` | Download new segments only |
| `stitch` | Build MP4s from what’s already downloaded |
| `sync` | `pull` then `stitch` |

## Where files go

- `~/Movies/comma/raw` — one-minute HEVC segments, same layout as the device
- `~/Movies/comma/videos` — `YYYY-MM-DD--HH-MM-SS__road.mp4` and `__wide.mp4`

A drive that is still being recorded is left for the next `sync`.

## Notes

- Default cameras are road + wide. Cabin camera: `COMMA_CAMERAS="fcamera ecamera dcamera" ./comma-dashcam sync`
- The device deletes old drives when its disk fills up. Sync after trips if you want to keep them.
- Playback is 20 fps HEVC in an MP4 (`hvc1`), which QuickTime and Photos can open.
