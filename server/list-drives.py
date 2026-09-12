import json
import os
import sys

CAM = {
    "fcamera.hevc": "road",
    "ecamera.hevc": "wide",
    "dcamera.hevc": "driver",
}

root = sys.argv[1] if len(sys.argv) > 1 else "/data/media/0/realdata"
drives = {}

if os.path.isdir(root):
    for name in os.listdir(root):
        path = os.path.join(root, name)
        if not os.path.isdir(path):
            continue
        parts = name.rsplit("--", 1)
        if len(parts) != 2 or not parts[1].isdigit():
            continue
        route, seg = parts[0], int(parts[1])
        d = drives.setdefault(
            route,
            {
                "segments": set(),
                "bytes": 0,
                "cameras": set(),
                "oldest": None,
                "newest": 0,
            },
        )
        d["segments"].add(seg)
        try:
            mt = os.stat(path).st_mtime
        except OSError:
            mt = 0
        if d["oldest"] is None or mt < d["oldest"]:
            d["oldest"] = mt
        if mt > d["newest"]:
            d["newest"] = mt
        try:
            files = os.listdir(path)
        except OSError:
            continue
        for fn in files:
            fp = os.path.join(path, fn)
            try:
                d["bytes"] += os.path.getsize(fp)
            except OSError:
                continue
            if fn in CAM:
                d["cameras"].add(CAM[fn])

out = []
for route, d in drives.items():
    segs = sorted(d["segments"])
    first = segs[0] if segs else 0
    last = segs[-1] if segs else 0
    expected = last - first + 1 if segs else 0
    out.append(
        {
            "id": route,
            "segments": len(segs),
            "firstSegment": first,
            "lastSegment": last,
            "gaps": bool(segs) and len(segs) != expected,
            "bytes": d["bytes"],
            "cameras": sorted(d["cameras"]),
            "startedAt": int(d["oldest"] or 0),
            "updatedAt": int(d["newest"] or 0),
        }
    )
out.sort(key=lambda x: (x["updatedAt"], x["id"]), reverse=True)
print(json.dumps(out))
