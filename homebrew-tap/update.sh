#!/bin/bash

# Exit on error
set -e

# Help message
if [ "$1" == "-h" ] || [ "$1" == "--help" ] || [ -z "$1" ]; then
  echo "Usage: ./update.sh <version>"
  echo "Example: ./update.sh 0.1.0"
  exit 1
fi

VERSION=$1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=========================================================="
echo "Updating FlipFlopper Homebrew Cask to version: $VERSION"
echo "=========================================================="

ARM_URL="https://github.com/AraujoJordan/FlipFlopper/releases/download/${VERSION}/FlipFlopper_${VERSION}_aarch64.dmg"
X64_URL="https://github.com/AraujoJordan/FlipFlopper/releases/download/${VERSION}/FlipFlopper_${VERSION}_x64.dmg"

# Temporary directory for downloading
TEMP_DIR=$(mktemp -d -t flipflopper-brew-XXXXXX)

echo "Downloading Apple Silicon (ARM64) DMG..."
if curl -L --fail -o "$TEMP_DIR/flipflopper_arm.dmg" "$ARM_URL"; then
  ARM_SHA=$(shasum -a 256 "$TEMP_DIR/flipflopper_arm.dmg" | cut -d ' ' -f 1)
  echo "✅ Apple Silicon SHA256: $ARM_SHA"
else
  echo "⚠️  Failed to download ARM64 DMG from: $ARM_URL"
  echo "Ensure the release exists and the assets are uploaded."
  ARM_SHA="PASTE_ARM64_SHA256_HERE"
fi

echo "Downloading Intel (x86_64) DMG..."
if curl -L --fail -o "$TEMP_DIR/flipflopper_x64.dmg" "$X64_URL"; then
  X64_SHA=$(shasum -a 256 "$TEMP_DIR/flipflopper_x64.dmg" | cut -d ' ' -f 1)
  echo "✅ Intel SHA256: $X64_SHA"
else
  echo "⚠️  Failed to download Intel DMG from: $X64_URL"
  echo "Ensure the release exists and the assets are uploaded."
  X64_SHA="PASTE_INTEL_SHA256_HERE"
fi

# Clean up temporary downloads
rm -rf "$TEMP_DIR"

# Create Casks directory inside the tap folder
mkdir -p "$SCRIPT_DIR/Casks"

# Generate Casks/flipflopper.rb inside the tap folder
cat <<EOF > "$SCRIPT_DIR/Casks/flipflopper.rb"
cask "flipflopper" do
  version "$VERSION"

  if Hardware::CPU.intel?
    sha256 "$X64_SHA"
    url "https://github.com/AraujoJordan/FlipFlopper/releases/download/#{version}/FlipFlopper_#{version}_x64.dmg"
  else
    sha256 "$ARM_SHA"
    url "https://github.com/AraujoJordan/FlipFlopper/releases/download/#{version}/FlipFlopper_#{version}_aarch64.dmg"
  end

  name "FlipFlopper"
  desc "Cross-platform desktop cockpit for CLI AI coding agents"
  homepage "https://github.com/AraujoJordan/FlipFlopper"

  app "FlipFlopper.app"

  zap trash: [
    "~/Library/Application Support/com.araujojordan.flipflopper",
    "~/Library/Caches/com.araujojordan.flipflopper",
    "~/Library/Preferences/com.araujojordan.flipflopper.plist",
    "~/Library/Saved Application State/com.araujojordan.flipflopper.savedState",
  ]
end
EOF

echo "=========================================================="
echo "Successfully generated Casks/flipflopper.rb inside $SCRIPT_DIR!"
echo "=========================================================="
