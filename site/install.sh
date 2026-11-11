#!/bin/sh
# p2p-swarm installer for macOS and Linux.
#
#   curl -fsSL https://lordx64.github.io/p2p-swarm/install.sh | sh
#
# Downloads the release for this machine from GitHub, checks it against the
# published SHA-256, and installs it under ~/.local. Nothing runs as root.
#
#   P2P_SWARM_VERSION=0.3.0   install a specific version (default: latest)
#   P2P_SWARM_INSTALL=<dir>   where the app goes (default: ~/.local/share/p2p-swarm)
#   P2P_SWARM_BIN=<dir>       where the `swarm` command goes (default: ~/.local/bin)
set -eu

REPO="lordx64/p2p-swarm"

say() { printf '%s\n' "$*"; }
fail() { printf 'install failed: %s\n' "$*" >&2; exit 1; }

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
  else fail "need curl or wget"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else fail "need sha256sum or shasum to verify the download"
  fi
}

main() {
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "unsupported system $(uname -s). On Windows use: irm https://lordx64.github.io/p2p-swarm/install.ps1 | iex" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "unsupported processor $(uname -m)" ;;
  esac
  target="$os-$arch"
  archive="p2p-swarm-$target.tar.gz"

  if [ -n "${P2P_SWARM_BASE_URL:-}" ]; then base="$P2P_SWARM_BASE_URL"
  elif [ -n "${P2P_SWARM_VERSION:-}" ]; then base="https://github.com/$REPO/releases/download/v${P2P_SWARM_VERSION#v}"
  else base="https://github.com/$REPO/releases/latest/download"
  fi
  dest="${P2P_SWARM_INSTALL:-$HOME/.local/share/p2p-swarm}"
  bindir="${P2P_SWARM_BIN:-$HOME/.local/bin}"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "Downloading p2p-swarm for $target..."
  fetch "$base/$archive" "$tmp/$archive" || fail "could not download $base/$archive"
  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download the checksum list"

  expected="$(grep " $archive\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$expected" ] || fail "no checksum published for $archive"
  actual="$(sha256_of "$tmp/$archive")"
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $archive (expected $expected, got $actual)"

  tar -xzf "$tmp/$archive" -C "$tmp"
  "$tmp/p2p-swarm/swarm" help >/dev/null 2>&1 || fail "the downloaded build does not run on this machine"
  version="$(cat "$tmp/p2p-swarm/VERSION")"

  # Replace any previous install, stopping its background node first so the
  # new version takes over. Swarm data lives in ~/.p2p-swarm and is untouched.
  if [ -x "$dest/swarm" ]; then "$dest/swarm" stop >/dev/null 2>&1 || true; fi
  mkdir -p "$(dirname "$dest")" "$bindir"
  rm -rf "$dest.old"
  if [ -e "$dest" ]; then mv "$dest" "$dest.old"; fi
  mv "$tmp/p2p-swarm" "$dest"
  rm -rf "$dest.old"
  ln -sf "$dest/swarm" "$bindir/swarm"

  say ""
  say "p2p-swarm $version installed: $bindir/swarm"
  case ":$PATH:" in
    *":$bindir:"*) ;;
    *) say ""
       say "Add it to your PATH (then open a new terminal):"
       say "  echo 'export PATH=\"$bindir:\$PATH\"' >> ~/.$(basename "${SHELL:-sh}")rc" ;;
  esac
  say ""
  say "Next:"
  say "  swarm create my-swarm      create a swarm and print its link"
  say "  swarm ui                   open the dashboard"
  say "  swarm agent <link>         lend this machine's Claude to a swarm"
  say ""
  say "Use it from inside Claude Code:"
  say "  claude mcp add --scope user swarm -- \"$bindir/swarm\" mcp"
}

main "$@"
