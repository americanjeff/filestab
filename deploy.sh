#!/usr/bin/env bash
# deploy.sh — register filestab in the web profile and (optionally) restart dsh-web.
#
# Run from a terminal that has your user systemd bus + full file access
# (the agent's sandbox is workspace-write and cannot reach the bus, so the
# restart is yours). Steps 1-2 are SAFE (no effect on the running GUI);
# step 3 is DISRUPTIVE (drops the live GUI and re-boots the host process).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="web"
PORT="${DSH_WEB_PORT:-51893}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
LEGACY_NAME="dsh-filez"   # pre-rename package name, if still linked

# One-time migration: drop the old `dsh-filez` link (and its bundle row) so it
# doesn't double-load alongside the renamed `filestab`. No-op if already gone.
if dsh plugin --profile "$PROFILE" list 2>/dev/null | grep -q "^ *\"${LEGACY_NAME}\"" \
   || grep -q "\"${LEGACY_NAME}\"" "$DSH_HOME_DIR/profiles/$PROFILE/package.json" 2>/dev/null; then
  echo "==> 0/3  Removing legacy '${LEGACY_NAME}' from profile '$PROFILE' (SAFE — no restart)"
  dsh plugin --profile "$PROFILE" remove "$LEGACY_NAME" || true
fi

echo "==> 1/3  Register filestab as a link bundle in profile '$PROFILE' (SAFE — no restart)"
# Thin pnpm forwarder: adds the link: dep to the profile and reconciles
# dsh.profile.bundles. Idempotent.
dsh plugin --profile "$PROFILE" add "link:$DIR"

echo
echo "==> 2/3  Pre-check: the composed web-profile tree includes filestab (SAFE — composes in a throwaway process, no port bind)"
if dsh web --dump-config | grep -n "filestab"; then
  echo "    ✓ filestab is in the composed tree"
else
  echo "    ✗ filestab NOT in the composed tree — check the profile package.json:"
  cat "$DSH_HOME_DIR/profiles/$PROFILE/package.json"
  exit 1
fi

echo
echo "==> 3/3  RESTART dsh-web.service  (DISRUPTIVE)"
echo "    This kills the process serving http://127.0.0.1:$PORT and re-boots it."
echo "    The open GUI page loses its transport and needs a reload; any in-flight turn is aborted."
read -r -p "    Restart now? [y/N] " ans
if [[ ! "${ans:-N}" =~ ^[Yy][Ee][Ss]?$ ]] && [[ ! "${ans:-N}" =~ ^[Yy]$ ]]; then
  echo "    Skipped restart. Run 'systemctl --user restart dsh-web.service' when ready."
  exit 0
fi

systemctl --user restart dsh-web.service
sleep 2
state="$(systemctl --user is-active dsh-web.service || true)"
echo "    dsh-web.service: $state"

echo
echo "==> Verify (SAFE):"
echo "    systemctl --user is-active dsh-web.service            # expect 'active'"
echo "    curl -sI http://127.0.0.1:$PORT/plugins/filestab/client.js   # expect 'HTTP/1.1 200'"
echo "    curl -s  http://127.0.0.1:$PORT/ | grep -o filestab  # row inlined into __DSH_BOOT__"
echo
echo "    Then hard-reload the GUI (Ctrl/Cmd-Shift-R), open a session, and click the Files tab."
echo "    (Later client edits hot-reload via the client-hmr watcher — no restart needed.)"
