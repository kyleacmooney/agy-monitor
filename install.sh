#!/usr/bin/env bash
set -euo pipefail
#
# install.sh — one-command bootstrap for agy-monitor (a zero-runtime-dep Node web app).
#
# agy-monitor has NO runtime npm dependencies — nothing to `npm install` for normal use
# (Playwright is a dev-only dependency, needed solely to run the test suite). This script
# wires up the optional pieces: the background daemon, the agy status hook, and a macOS
# desktop app wrapper.
#
# Usage:
#   ./install.sh                 # run health checks (doctor) + print the next-steps menu
#   ./install.sh --daemon        # install the launchd background daemon (macOS)
#   ./install.sh --hook          # register the agy status hook in ~/.gemini/config/hooks.json
#   ./install.sh --app           # build the "Agy Monitor" macOS app bundle
#   ./install.sh --all           # daemon, then hook, then app, then doctor (final verify)
#
# Flags are combinable and always run in the fixed order daemon -> hook -> app, regardless
# of the order given on the command line. PORT is honoured and passed through where relevant.

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_INSTALL="$APP_DIR/daemon/install.sh"
HOOK_INSTALL="$APP_DIR/install-hooks.js"
APP_BUILD="$APP_DIR/scripts/make-app.sh"
DOCTOR="$APP_DIR/bin/doctor.js"
MIN_NODE_MAJOR=20

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Error: node not found on PATH. Install Node.js >= $MIN_NODE_MAJOR from https://nodejs.org and re-run." >&2
    exit 1
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    echo "Error: Node.js >= $MIN_NODE_MAJOR required (found $(node -v)). Upgrade via https://nodejs.org and re-run." >&2
    exit 1
  fi
  echo "✓ node $(node -v) (>= $MIN_NODE_MAJOR)"
  echo "  (no runtime npm dependencies — nothing to install; Playwright is dev-only, for tests)"
}

# ---------------------------------------------------------------------------
# Components
# ---------------------------------------------------------------------------

run_doctor() {
  if [ ! -f "$DOCTOR" ]; then
    echo "! doctor not found at $DOCTOR — skipping health check." >&2
    return 0
  fi
  echo "==> running health check (bin/doctor.js)"
  # Don't let a failing doctor abort the bootstrap — we still want to show next steps.
  node "$DOCTOR" || echo "! doctor reported problems (see above)." >&2
}

install_daemon() {
  if [ ! -x "$DAEMON_INSTALL" ]; then
    echo "Error: daemon installer not found or not executable: $DAEMON_INSTALL" >&2
    exit 1
  fi
  echo "==> installing background daemon"
  if [ -n "${PORT:-}" ]; then
    PORT="$PORT" "$DAEMON_INSTALL"
  else
    "$DAEMON_INSTALL"
  fi
}

install_hook() {
  if [ ! -f "$HOOK_INSTALL" ]; then
    echo "Error: hook installer not found: $HOOK_INSTALL" >&2
    exit 1
  fi
  echo "==> registering agy status hook"
  node "$HOOK_INSTALL"
}

install_app() {
  if [ ! -x "$APP_BUILD" ]; then
    echo "Error: app builder not found or not executable: $APP_BUILD" >&2
    exit 1
  fi
  echo "==> building macOS app bundle"
  "$APP_BUILD"
}

print_menu() {
  local port="${PORT:-8719}"
  cat <<MENU

Next steps — pick what you want (flags are combinable):

  ./install.sh --daemon    background daemon (launchd; starts at login, auto-restarts)
  ./install.sh --hook      register the agy status hook (~/.gemini/config/hooks.json)
  ./install.sh --app       build the "Agy Monitor" macOS app (opens like a native app)
  ./install.sh --all       all of the above, then a final health check

  npm start                run in the foreground now → http://127.0.0.1:$port
MENU
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  check_node

  if [ "$#" -eq 0 ]; then
    run_doctor
    print_menu
    exit 0
  fi

  # Collect requested components, then run them in a fixed order (daemon -> hook -> app)
  # so argument order never changes the outcome.
  local want_daemon=0 want_hook=0 want_app=0 want_all=0
  for arg in "$@"; do
    case "$arg" in
      --daemon) want_daemon=1 ;;
      --hook)   want_hook=1 ;;
      --app)    want_app=1 ;;
      --all)    want_all=1 ;;
      -h|--help)
        print_menu
        exit 0
        ;;
      *)
        echo "Error: unknown flag: $arg" >&2
        print_menu
        exit 1
        ;;
    esac
  done

  if [ "$want_all" -eq 1 ]; then
    want_daemon=1 want_hook=1 want_app=1
  fi

  [ "$want_daemon" -eq 1 ] && install_daemon
  [ "$want_hook" -eq 1 ]   && install_hook
  [ "$want_app" -eq 1 ]    && install_app

  # --all ends with a final verification pass.
  if [ "$want_all" -eq 1 ]; then
    echo
    run_doctor
  fi

  echo
  echo "✓ done."
}

main "$@"
