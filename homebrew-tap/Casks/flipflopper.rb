cask "flipflopper" do
  version "0.10.0"

  if Hardware::CPU.intel?
    sha256 "3a5f3c56278643e9e287cf6323c673293dbb68281adc2357778e115b618d7699"
    url "https://github.com/AraujoJordan/FlipFlopper/releases/download/#{version}/FlipFlopper_#{version}_x64.dmg"
  else
    sha256 "72075b67e484dd18085bed297d9a0cdc00c16701f601d2f45d496a4f451750c6"
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
