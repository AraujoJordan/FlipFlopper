cask "flipflopper" do
  version "0.25.1"

  if Hardware::CPU.intel?
    sha256 "ab699ce4cf55957872b325927e97ab47c652627fd30083abba6980f16ea8b606"
    url "https://github.com/AraujoJordan/FlipFlopper/releases/download/#{version}/FlipFlopper_#{version}_x64.dmg"
  else
    sha256 "75da29933d38bb54d0188d51cef51b71c443fcfc15c1e7b0dad4759ffb2a5635"
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
