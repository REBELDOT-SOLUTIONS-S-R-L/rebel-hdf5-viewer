#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCHER="$ROOT_DIR/scripts/launch_desktop.sh"
ICON="$ROOT_DIR/public/favicon.ico"

install_launcher() {
  local applications_dir="$1"
  local desktop_file="$applications_dir/rebelhdf5.desktop"
  local owner="${2:-}"

  mkdir -p "$applications_dir"
  cat > "$desktop_file" <<EOF
[Desktop Entry]
Type=Application
Name=rebelHDF5
Comment=Local HDF5 viewer and processing app
Exec="$LAUNCHER"
Icon=$ICON
Terminal=false
Categories=Science;Development;
StartupWMClass=rebelHDF5
EOF

  chmod 0644 "$desktop_file"
  if [[ -n "$owner" ]]; then
    chown "$owner:$(id -gn "$owner")" "$applications_dir" "$desktop_file"
  fi

  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$applications_dir" >/dev/null 2>&1 || true
  fi
  echo "Installed $desktop_file"
}

if [[ $# -eq 0 ]]; then
  install_launcher "${XDG_DATA_HOME:-$HOME/.local/share}/applications"
elif [[ "$1" == --users && $# -gt 1 ]]; then
  if [[ $EUID -ne 0 ]]; then
    echo "Installing for other users requires sudo: sudo bash $0 --users USER..." >&2
    exit 1
  fi
  shift
  # Validate every account before changing any user's launcher.
  for user in "$@"; do
    if ! getent passwd "$user" >/dev/null; then
      echo "Unknown user: $user" >&2
      exit 1
    fi
  done
  for user in "$@"; do
    user_home="$(getent passwd "$user" | cut -d: -f6)"
    # Run directory creation as the account so new .local/share parents are
    # owned by that account, even when the installer is run with sudo.
    runuser -u "$user" -- mkdir -p "$user_home/.local/share/applications"
    install_launcher "$user_home/.local/share/applications" "$user"
  done
else
  echo "Usage: $0 [--users USER...]" >&2
  exit 1
fi

echo "Open the Dash and search for rebelHDF5."
