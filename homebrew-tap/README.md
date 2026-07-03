# homebrew-tap

Personal Homebrew Tap for Jordan L. Araujo Jr. (@AraujoJordan).

## 🚀 How to Install FlipFlopper

To install the **FlipFlopper** desktop GUI app on macOS, tap this repository and install the Cask:

```bash
# 1. Tap this repository
brew tap AraujoJordan/tap

# 2. Install FlipFlopper Cask
brew install --cask flipflopper
```

---

## 🤖 Automate Tap Updates via GitHub Actions

You can easily automate updates so that every time you release a new version of **FlipFlopper**, the Homebrew Tap is updated automatically.

### Step 1: Create a Personal Access Token (PAT)
1. Go to your GitHub Settings -> Developer settings -> **Personal access tokens** -> **Tokens (classic)**.
2. Generate a new token with `repo` scope.
3. Save it as a Repository Secret in the main `FlipFlopper` repository named `TAP_GITHUB_TOKEN`.

### Step 2: Add this step to your `release.yml`
Append this step to the end of the macOS build job in `.github/workflows/release.yml`:

```yaml
      - name: Update Homebrew Tap Cask
        env:
          TAP_TOKEN: ${{ secrets.TAP_GITHUB_TOKEN }}
        run: |
          git config --global user.name "github-actions[bot]"
          git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"
          
          # Clone the tap repository
          git clone https://x-access-token:${TAP_TOKEN}@github.com/AraujoJordan/homebrew-tap.git temp-tap
          cd temp-tap
          
          # Run the update script with the released version tag
          # (Strips any leading 'v' if present for semantic versioning consistency)
          CLEAN_TAG=$(echo "${{ env.RELEASE_TAG }}" | sed 's/^v//')
          ./update.sh "$CLEAN_TAG"
          
          # Commit and push changes back to the tap
          git add Casks/flipflopper.rb
          git commit -m "chore: bump flipflopper to $CLEAN_TAG" || echo "No changes to commit"
          git push origin main
```
