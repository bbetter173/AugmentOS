#!/bin/bash
#
# MentraOS Mac mini self-hosted runner bootstrap.
#
# Bootstraps a fresh Mac mini into a working GitHub Actions runner for the
# MentraOS iOS + Android pipelines. Run once per new machine. Re-running is
# safe — every step is idempotent.
#
# Manual prerequisites (do these once before running this script):
#   1. Sign in to the Mac with the dedicated CI Apple ID.
#   2. Install Xcode from the App Store, launch it once, accept the license.
#      (sudo xcodebuild -license accept will be run by this script too.)
#   3. Generate the secrets below.
#
# Required env vars:
#   GH_RUNNER_URL     - e.g. https://github.com/Mentra-Community/MentraOS
#   GH_RUNNER_TOKEN   - short-lived registration token from
#                       Repo > Settings > Actions > Runners > New self-hosted runner
#   TAILSCALE_AUTHKEY - ephemeral, single-use, tagged tag:ci
#                       https://login.tailscale.com/admin/settings/keys
#
# Optional env vars:
#   RUNNER_NAME       - defaults to the machine's hostname
#   RUNNER_LABELS     - comma-separated extra labels (in addition to the
#                       default self-hosted,macOS,ARM64 set)
#   RUNNER_VERSION    - actions/runner version, defaults to latest stable
#   SKIP_ANDROID      - set to 1 to skip Android Studio + SDK install
#   SKIP_TAILSCALE    - set to 1 to skip Tailscale install/login
#
# Usage:
#   GH_RUNNER_URL=https://github.com/Mentra-Community/MentraOS \
#   GH_RUNNER_TOKEN=ghs_xxx \
#   TAILSCALE_AUTHKEY=tskey-auth-xxx \
#   ./mobile/scripts/setup-runner.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()  { echo -e "${RED}[ERR]${NC} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

[[ "$(uname -s)" == "Darwin" ]] || fail "This script only runs on macOS."
[[ "$(uname -m)" == "arm64" ]]  || fail "Apple Silicon required (arm64)."

: "${GH_RUNNER_URL:?Set GH_RUNNER_URL (e.g. https://github.com/Mentra-Community/MentraOS)}"
: "${GH_RUNNER_TOKEN:?Set GH_RUNNER_TOKEN from GitHub > Settings > Actions > Runners > New self-hosted runner}"
if [[ "${SKIP_TAILSCALE:-0}" != "1" ]]; then
    : "${TAILSCALE_AUTHKEY:?Set TAILSCALE_AUTHKEY (or SKIP_TAILSCALE=1)}"
fi

RUNNER_NAME="${RUNNER_NAME:-$(scutil --get LocalHostName 2>/dev/null || hostname -s)}"
RUNNER_LABELS_EXTRA="${RUNNER_LABELS:-}"
RUNNER_VERSION="${RUNNER_VERSION:-2.319.1}"

RUNNER_HOME="$HOME/mentra/actions-runner-$RUNNER_NAME"
WORK_DIR="$RUNNER_HOME/_work"

info "Configuring runner '$RUNNER_NAME' under $RUNNER_HOME"

# ---------------------------------------------------------------------------
# Xcode license + CLI tools
# ---------------------------------------------------------------------------

info "Ensuring Xcode CLI tools are installed"
if ! xcode-select -p >/dev/null 2>&1; then
    xcode-select --install || true
    warn "Xcode CLI tools were missing. Re-run this script after the GUI install completes."
    exit 1
fi

if [[ -d "/Applications/Xcode.app" ]]; then
    sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
    sudo xcodebuild -license accept || true
    sudo xcodebuild -runFirstLaunch || true
    ok "Xcode pointed at /Applications/Xcode.app"
else
    fail "Xcode.app not found in /Applications. Install Xcode from the App Store first."
fi

# ---------------------------------------------------------------------------
# Homebrew
# ---------------------------------------------------------------------------

if ! command -v brew >/dev/null 2>&1; then
    info "Installing Homebrew"
    NONINTERACTIVE=1 /bin/bash -c \
        "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# Ensure brew is on PATH for the rest of this script + future shells.
BREW_PREFIX="/opt/homebrew"
eval "$($BREW_PREFIX/bin/brew shellenv)"

ZPROFILE="$HOME/.zprofile"
if ! grep -q 'brew shellenv' "$ZPROFILE" 2>/dev/null; then
    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$ZPROFILE"
fi
ok "Homebrew ready"

# ---------------------------------------------------------------------------
# Core toolchain
# ---------------------------------------------------------------------------

info "Installing core toolchain"
brew update
brew install \
    bun \
    git \
    git-lfs \
    gh \
    cocoapods \
    fastlane \
    watchman \
    swiftformat \
    openjdk@17 \
    xcbeautify \
    coreutils \
    jq \
    applesimutils \
    xcodesorg/made/xcodes

# Maestro is distributed as a single binary, not a brew formula.
if ! command -v maestro >/dev/null 2>&1; then
    info "Installing Maestro"
    curl -fsSL "https://get.maestro.mobile.dev" | bash
fi
# Maestro installs to ~/.maestro/bin — make sure that's on PATH for future shells.
if ! grep -q '\.maestro/bin' "$ZPROFILE" 2>/dev/null; then
    echo 'export PATH="$HOME/.maestro/bin:$PATH"' >> "$ZPROFILE"
fi
export PATH="$HOME/.maestro/bin:$PATH"

# Java 17 needs a symlink to be picked up by /usr/libexec/java_home.
if [[ ! -L "/Library/Java/JavaVirtualMachines/openjdk-17.jdk" ]]; then
    sudo ln -sfn \
        "$BREW_PREFIX/opt/openjdk@17/libexec/openjdk.jdk" \
        "/Library/Java/JavaVirtualMachines/openjdk-17.jdk"
fi

# Ruby for fastlane / cocoapods. Use system Ruby + bundler.
gem install bundler --no-document || true

ok "Core toolchain installed"

# ---------------------------------------------------------------------------
# Android (optional)
# ---------------------------------------------------------------------------

if [[ "${SKIP_ANDROID:-0}" != "1" ]]; then
    info "Installing Android SDK"
    brew install --cask android-commandlinetools || true

    ANDROID_HOME="$HOME/Library/Android/sdk"
    mkdir -p "$ANDROID_HOME"
    export ANDROID_HOME
    export ANDROID_SDK_ROOT="$ANDROID_HOME"

    SDKMANAGER="$BREW_PREFIX/share/android-commandlinetools/cmdline-tools/latest/bin/sdkmanager"
    if [[ -x "$SDKMANAGER" ]]; then
        yes | "$SDKMANAGER" --sdk_root="$ANDROID_HOME" --licenses >/dev/null || true
        "$SDKMANAGER" --sdk_root="$ANDROID_HOME" \
            "platform-tools" \
            "build-tools;34.0.0" \
            "platforms;android-34" \
            "ndk;26.1.10909125" \
            "cmake;3.22.1" || true
    else
        warn "sdkmanager not found at $SDKMANAGER — install Android tools manually if needed."
    fi

    # Persist Android env vars for future shells + the runner service.
    if ! grep -q "ANDROID_HOME" "$ZPROFILE"; then
        cat >> "$ZPROFILE" <<EOF

# Android SDK (added by setup-runner.sh)
export ANDROID_HOME="\$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="\$ANDROID_HOME"
export PATH="\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/cmdline-tools/latest/bin:\$PATH"
EOF
    fi
    ok "Android SDK installed"
else
    info "Skipping Android SDK (SKIP_ANDROID=1)"
fi

# ---------------------------------------------------------------------------
# Tailscale
# ---------------------------------------------------------------------------

if [[ "${SKIP_TAILSCALE:-0}" != "1" ]]; then
    info "Installing Tailscale"
    if ! command -v tailscale >/dev/null 2>&1; then
        brew install --cask tailscale
    fi

    # The cask installs the GUI app. Launching it once registers the system
    # extension so the CLI works.
    open -a "Tailscale" || true
    sleep 5

    info "Joining tailnet"
    sudo tailscale up \
        --authkey="$TAILSCALE_AUTHKEY" \
        --hostname="$RUNNER_NAME" \
        --ssh \
        --accept-routes
    ok "Tailscale up"
else
    info "Skipping Tailscale (SKIP_TAILSCALE=1)"
fi

# ---------------------------------------------------------------------------
# Power + auto-login behavior for a headless build box
# ---------------------------------------------------------------------------

info "Disabling sleep and enabling auto-restart"
sudo pmset -a sleep 0
sudo pmset -a disksleep 0
sudo pmset -a displaysleep 30
sudo pmset -a autorestart 1
sudo pmset -a powernap 0
sudo systemsetup -setrestartfreeze on >/dev/null 2>&1 || true
sudo systemsetup -setrestartpowerfailure on >/dev/null 2>&1 || true
ok "Power settings tuned for unattended use"

# Auto-login is set in System Settings > Users & Groups (requires GUI + the
# user's password). The runner uses launchd anyway, so we don't strictly need
# auto-login — but it makes recovering from a power-cut faster.
warn "Auto-login is GUI-only on modern macOS. Set it once in System Settings > Users & Groups."

# ---------------------------------------------------------------------------
# File descriptor limits
# ---------------------------------------------------------------------------
# RN + Metro + watchman + Xcode routinely blow past the macOS default 256 fd
# soft limit, surfacing as flaky EMFILE / "too many open files" errors that
# look like build flakes but are pure config. Bump system-wide limits.

info "Raising file descriptor limits"
sudo tee /Library/LaunchDaemons/limit.maxfiles.plist >/dev/null <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
        "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>limit.maxfiles</string>
    <key>ProgramArguments</key>
    <array>
      <string>launchctl</string>
      <string>limit</string>
      <string>maxfiles</string>
      <string>524288</string>
      <string>524288</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>ServiceIPC</key><false/>
  </dict>
</plist>
PLIST
sudo chown root:wheel /Library/LaunchDaemons/limit.maxfiles.plist
sudo chmod 644 /Library/LaunchDaemons/limit.maxfiles.plist
sudo launchctl load -w /Library/LaunchDaemons/limit.maxfiles.plist 2>/dev/null || true
ok "File descriptor limit raised to 524288 (system-wide)"

# ---------------------------------------------------------------------------
# Spotlight exclusions
# ---------------------------------------------------------------------------
# Spotlight indexing Xcode DerivedData and the runner workspace burns 5-10%
# CPU during builds and contends with the SSD. Exclude them.

info "Excluding build dirs from Spotlight"
mkdir -p "$HOME/mentra"
mkdir -p "$HOME/Library/Developer/Xcode/DerivedData"
sudo mdutil -i off "$HOME/mentra" 2>/dev/null || true
sudo mdutil -i off "$HOME/Library/Developer/Xcode/DerivedData" 2>/dev/null || true
sudo mdutil -i off "$HOME/Library/Caches/CocoaPods" 2>/dev/null || true
ok "Spotlight indexing disabled for build artifact directories"

# ---------------------------------------------------------------------------
# GitHub Actions runner
# ---------------------------------------------------------------------------

info "Installing GitHub Actions runner v$RUNNER_VERSION at $RUNNER_HOME"
mkdir -p "$RUNNER_HOME"
cd "$RUNNER_HOME"

if [[ ! -f ./config.sh ]]; then
    RUNNER_TARBALL="actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz"
    curl -fL -o "$RUNNER_TARBALL" \
        "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_TARBALL}"
    tar xzf "$RUNNER_TARBALL"
    rm -f "$RUNNER_TARBALL"
fi

# Default labels match what the workflows already select on.
LABELS="self-hosted,macOS,ARM64"
if [[ -n "$RUNNER_LABELS_EXTRA" ]]; then
    LABELS="$LABELS,$RUNNER_LABELS_EXTRA"
fi

if [[ ! -f ./.runner ]]; then
    ./config.sh \
        --url "$GH_RUNNER_URL" \
        --token "$GH_RUNNER_TOKEN" \
        --name "$RUNNER_NAME" \
        --labels "$LABELS" \
        --work "$WORK_DIR" \
        --unattended \
        --replace
else
    info "Runner already configured for $(grep -o '"agentName"[^,]*' .runner || echo unknown). Skipping config.sh."
fi

# Bake env vars the runner should see at job time. The runner reads ./.env
# on startup. Keep this in sync with what the workflows expect.
{
    echo "PATH=$BREW_PREFIX/bin:$BREW_PREFIX/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    echo "LANG=en_US.UTF-8"
    echo "JAVA_HOME=$BREW_PREFIX/opt/openjdk@17"
    if [[ "${SKIP_ANDROID:-0}" != "1" ]]; then
        echo "ANDROID_HOME=$HOME/Library/Android/sdk"
        echo "ANDROID_SDK_ROOT=$HOME/Library/Android/sdk"
    fi
} > "$RUNNER_HOME/.env"

# Install + start the launchd service so the runner survives reboots.
if ! ./svc.sh status >/dev/null 2>&1; then
    sudo ./svc.sh install "$USER"
fi
sudo ./svc.sh start || true
ok "Runner registered and running as a launchd service"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

cat <<EOF

==========================================================================
  Runner '$RUNNER_NAME' is up.
  Labels: $LABELS
  Home:   $RUNNER_HOME
  Status: cd $RUNNER_HOME && ./svc.sh status

  Next steps you should do manually once:
    - System Settings > Users & Groups > set this user to auto-login
    - System Settings > Lock Screen > Require password "Never"
    - Sign in to the Apple Developer account in Xcode (Settings > Accounts)
    - Confirm the runner appears at $GH_RUNNER_URL/settings/actions/runners
==========================================================================
EOF
