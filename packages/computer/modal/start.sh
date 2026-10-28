#!/bin/sh
# Boot one Mano desktop: Xvfb screen, window manager, Chromium, live view, control server.
set -eu
WIDTH=${WIDTH:-1280}
HEIGHT=${HEIGHT:-800}
PROFILE=${PROFILE:-default}
export DISPLAY=:99
Xvfb :99 -screen 0 "${WIDTH}x${HEIGHT}x24" >/tmp/xvfb.log 2>&1 &
sleep 1
fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -quiet >/tmp/x11vnc.log 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
mkdir -p /uploads
python3 /root/control.py &
mkdir -p "/profiles/${PROFILE}"
chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="/profiles/${PROFILE}" \
  --window-size="${WIDTH},${HEIGHT}" --window-position=0,0 --start-maximized \
  about:blank >/tmp/chromium.log 2>&1 &
wait
