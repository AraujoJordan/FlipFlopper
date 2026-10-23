cask "flipflopper" do
  version "0.13.0"

  if Hardware::CPU.intel?
    sha256 "88b1bf5c8c9bb64e3e1103808e6d7f8a02588eb20649a6b2ee4d65dc7cc194c2"
    url "https://github.com/AraujoJordan/FlipFlopper/releases/download/#{version}/FlipFlopper_#{version}_x64.dmg"
  else
    sha256 "b36b6ea1ea09738ca052458df2dec9bdb27df2bea77d5571e02420a29a4f7512"
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
