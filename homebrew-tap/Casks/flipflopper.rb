cask "flipflopper" do
  version "0.18.1"

  if Hardware::CPU.intel?
    sha256 "5626e2a609d5e08d6039f68d6f3ba547d610057ed26c6b8df6469c32c901b4e1"
    url "https://github.com/AraujoJordan/FlipFlopper/releases/download/\#{version}/FlipFlopper_\#{version}_x64.dmg"
  else
    sha256 "78421088d937ebcfd9f2023d35a85f6afd537c0f847e6f29a900b19147ba2b48"
    url "https://github.com/AraujoJordan/FlipFlopper/releases/download/\#{version}/FlipFlopper_\#{version}_aarch64.dmg"
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
