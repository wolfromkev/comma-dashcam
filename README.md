# comma-dashcam

Pull road-camera footage off a [comma](https://comma.ai) device over your home Wi‑Fi and stitch each drive into playable MP4s.

The files stay on your computer. Nothing is uploaded to connect.comma.ai. The device is reached with SSH on the local network, and only while it is on the same Wi‑Fi as you.

## Requirements

- macOS. The command-line script also runs on Linux if the same tools are installed.
- `ssh` and `rsync`
- [ffmpeg](https://ffmpeg.org) (this includes `ffprobe`)
- Node.js `20.19+` or `22.12+`, only if you want the web UI

On a Mac:

```bash
brew install ffmpeg
```

`rsync` is already on macOS. If Homebrew’s `rsync` is installed, the script uses that.

## Install

```bash
git clone https://github.com/wolfromkev/comma-dashcam.git
cd comma-dashcam
chmod +x comma-dashcam
```

The command-line tool does not need `npm install`.

## Connect to the device

The comma does not take a password. It copies the public SSH keys from a GitHub account you name in its settings. Your computer and the device have to be on the same Wi‑Fi.

1. Find the device name on the comma: **Settings → Network**. It looks like `comma-xxxxxx.local`.
2. Run setup with that name. This creates an SSH key if you do not already have one, adds a `comma` host to `~/.ssh/config`, and copies the public key to the clipboard on a Mac.

```bash
COMMA_MDNS=comma-xxxxxx.local ./comma-dashcam setup
```

3. Add that public key on GitHub: **Settings → SSH and GPG keys → New SSH key**. Setup prints the key in the terminal.
4. On the comma: **Settings → Network → Advanced → SSH Keys → Add**, and enter **your** GitHub username. If a username is already there, remove it and add it again so the device fetches the new key.
5. Run `./comma-dashcam setup` again. It tells you when login works.

To keep footage off comma’s servers, turn off raw and route uploads in those same network settings.

## Everyday use

The car and the comma need to be on your Wi‑Fi.

```bash
./comma-dashcam sync
```

That downloads new segments, then writes one MP4 per camera for each finished drive.

| Command | What it does |
|---|---|
| `setup` | Write the SSH host and check login |
| `status` | Show whether the device is reachable and what is already downloaded |
| `pull` | Download new segments only |
| `stitch` | Build MP4s from segments already on disk |
| `sync` | `pull`, then `stitch` |

A drive that is still being recorded is skipped and picked up on the next sync.

## Web UI

The browser UI lists every drive, shows device and disk space, and copies or moves the drives you select. Copy is the default. Move deletes the selected drives from the comma after they are on your computer. You can also stitch MP4s from the same screen.

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5174. Choose a save folder in the UI, or paste a path. The API listens on `127.0.0.1` only.

## Where files go

The default library is `~/Movies/comma`. Change it with `COMMA_DEST`, or with the folder picker in the web UI. The UI stores that path in `~/.config/comma-dashcam.json`.

| Path | Contents |
|---|---|
| `~/Movies/comma/raw` | One-minute HEVC segments, in the same layout as the device |
| `~/Movies/comma/videos` | One MP4 per camera per drive |

Video names end in `__road.mp4` (forward camera), `__wide.mp4` (wide camera), or `__driver.mp4` (cabin camera).

## Options

| Variable | Default | What it sets |
|---|---|---|
| `COMMA_MDNS` | none | Device name, such as `comma-xxxxxx.local`. Required the first time `setup` writes the SSH host |
| `COMMA_HOST` | `comma` | SSH host alias |
| `COMMA_DEST` | `~/Movies/comma` | Local library. Overrides the saved UI folder for that command |
| `COMMA_CAMERAS` | `fcamera ecamera` | Cameras to pull and stitch |
| `COMMA_FPS` | `20` | Playback frame rate written into the MP4 |
| `COMMA_SSH_KEY` | `~/.ssh/id_ed25519` | Key used to log in |
| `COMMA_SKIP_SECS` | `120` | Skip a drive whose newest segment is newer than this |

Cabin camera:

```bash
COMMA_CAMERAS="fcamera ecamera dcamera" ./comma-dashcam sync
```

## Notes

- Playback is 20 fps HEVC in an MP4 tagged `hvc1`, which QuickTime and Photos can open.
- The comma deletes old drives when its own disk fills up. Sync after a trip if you want to keep it.
- An interrupted download resumes on the next `pull` or `sync`.
