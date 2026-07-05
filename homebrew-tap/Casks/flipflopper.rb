cask "flipflopper" do
  version "0.1.5"

  if Hardware::CPU.intel?
    sha256 "a56afc086778db379bce56f3fe1cd8e86324ab4ad70d262657b91111bb72e270"
    url "https://github.com/AraujoJordan/FlipFlopper/releases/download/#{version}/FlipFlopper_#{version}_x64.dmg"
  else
    sha256 "717fd8a7b6a65c2938abca79f657c72c45e5750c42044a361c9e8d70b0643964"
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
