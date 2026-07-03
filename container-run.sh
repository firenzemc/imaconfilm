#!/usr/bin/env bash
# Run filmtool under Apple `container` (native macOS containers, Apple Silicon).
#
#   FFF_DIR=~/Pictures/Film ./container-run.sh        # point at your scan folder
#   ./container-run.sh --build                        # force a rebuild first
#
# IMPORTANT — mount a SPECIFIC scan folder, NOT your whole $HOME. Apple
# container's virtiofs cannot traverse macOS's protected home dirs (~/Library,
# ~/Pictures, ~/Documents, …) and the container will HANG on any file access.
# If your scans live under a TCC-protected dir (~/Pictures, ~/Documents,
# ~/Desktop, ~/Downloads), either keep them somewhere else (e.g. ~/Film) or
# grant `container` Full Disk Access in System Settings › Privacy & Security.
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8790}"
FFF_DIR="${FFF_DIR:-$HOME/Pictures/Film}"

if [ ! -d "$FFF_DIR" ]; then
  echo "Scan folder not found: $FFF_DIR"
  echo "Point FFF_DIR at the folder that holds your .fff scans, e.g.:"
  echo "  FFF_DIR=/path/to/scans $0"
  exit 1
fi

# build the image once (skip if present; pass --build to force a rebuild)
if [ "$1" = "--build" ] || ! container image inspect filmtool:latest >/dev/null 2>&1; then
  container build -t filmtool:latest ./filmtool
fi

# (re)create the container, published on all interfaces so the tailnet can reach it
container rm -f filmtool >/dev/null 2>&1 || true
container run -d --name filmtool -p "0.0.0.0:${PORT}:8790" -v "$FFF_DIR:/data" filmtool:latest >/dev/null

IP="$(tailscale ip -4 2>/dev/null | head -1)"
echo "filmtool running:"
echo "  mount:   $FFF_DIR -> /data"
echo "  local:   http://localhost:${PORT}/"
[ -n "$IP" ] && echo "  tailnet: http://${IP}:${PORT}/"
echo "stop:  container stop filmtool   |   logs:  container logs -f filmtool"
