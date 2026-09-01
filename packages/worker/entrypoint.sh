#!/bin/sh
# Start a virtual X display so the master Teams sign-in can run a real,
# non-headless browser (Microsoft blocks headless logins). Ordinary runs are
# headless and ignore it. Running Xvfb explicitly and exec-ing the worker is
# far more reliable for a long-lived service than wrapping it in xvfb-run.
set -e

Xvfb :99 -screen 0 1280x720x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
export DISPLAY=:99

# Give Xvfb a moment to create its socket before the app might need it.
i=0
while [ ! -e /tmp/.X11-unix/X99 ] && [ "$i" -lt 20 ]; do
  i=$((i + 1))
  sleep 0.25
done

exec npm run start -w @automation/worker
