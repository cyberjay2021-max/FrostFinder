# Homebrew Cask for FrostFinder
# Submit to: https://github.com/Homebrew/homebrew-cask
# Place this file in Casks/f/frostfinder.rb

cask "frostfinder" do
  version "6.0.26"

  # Intel macOS
  on_intel do
    url "https://github.com/frostfinder/frostfinder/releases/download/v#{version}/FrostFinder_#{version}_x64.dmg"
    sha256 "REPLACE_WITH_ACTUAL_SHA256_x64"
  end

  # Apple Silicon macOS
  on_arm do
    url "https://github.com/frostfinder/frostfinder/releases/download/v#{version}/FrostFinder_#{version}_aarch64.dmg"
    sha256 "REPLACE_WITH_ACTUAL_SHA256_aarch64"
  end

  name "FrostFinder"
  desc "A fast, modern file manager inspired by macOS Finder"
  homepage "https://github.com/frostfinder/frostfinder"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "FrostFinder.app"

  zap trash: [
    "~/Library/Application Support/com.frostfinder.desktop",
    "~/Library/Caches/com.frostfinder.desktop",
    "~/Library/Logs/com.frostfinder.desktop",
    "~/.config/rclone/frostfinder_*",
  ]
end
