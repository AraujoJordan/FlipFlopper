import os
import urllib.request
import urllib.parse
import json

# Define the icons directory
ICONS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "public", "icons"))
os.makedirs(ICONS_DIR, exist_ok=True)

# List of language configurations
# Each entry: (filename, source_type, key)
# source_type can be:
# - 'devicon': fetches from devicon CDN
# - 'simpleicons': fetches from simpleicons CDN
# - 'url': fetches from direct URL
icon_sources = [
    # Top 30 code languages
    ("javascript", "devicon", "javascript"),
    ("python", "devicon", "python"),
    ("java", "devicon", "java"),
    ("typescript", "devicon", "typescript"),
    ("csharp", "devicon", "csharp"),
    ("cplusplus", "devicon", "cplusplus"),
    ("c", "devicon", "c"),
    ("php", "devicon", "php"),
    ("go", "devicon", "go"),
    ("rust", "devicon", "rust"),
    ("ruby", "devicon", "ruby"),
    ("swift", "devicon", "swift"),
    ("kotlin", "devicon", "kotlin"),
    ("sql", "simpleicons", "sqlite"), # sqldeveloper or sqlite
    ("bash", "devicon", "bash"),
    ("powershell", "devicon", "powershell"),
    ("dart", "devicon", "dart"),
    ("scala", "devicon", "scala"),
    ("r", "devicon", "r"),
    ("lua", "devicon", "lua"),
    ("haskell", "devicon", "haskell"),
    ("elixir", "devicon", "elixir"),
    ("clojure", "devicon", "clojure"),
    ("perl", "devicon", "perl"),
    ("objectivec", "url", "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/objectivec/objectivec-plain.svg"),
    ("groovy", "devicon", "groovy"),
    ("julia", "devicon", "julia"),
    ("fsharp", "devicon", "fsharp"),
    ("assembly", "simpleicons", "webassembly"), # fallback to webassembly for assembly
    ("matlab", "devicon", "matlab"),
    
    # Top 10 markup / stylesheet / config / data languages
    ("html", "devicon", "html5"),
    ("css", "devicon", "css3"),
    ("markdown", "devicon", "markdown"),
    ("xml", "devicon", "xml"),
    ("json", "devicon", "json"),
    ("yaml", "devicon", "yaml"),
    ("svg", "simpleicons", "svg"),
    ("csv", "simpleicons", "googlesheets"),
    ("toml", "simpleicons", "toml"),
    ("latex", "devicon", "latex")
]

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

def download_icon(name, src_type, key):
    dest_path = os.path.join(ICONS_DIR, f"{name}.svg")
    
    if src_type == "devicon":
        url = f"https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/{key}/{key}-original.svg"
    elif src_type == "simpleicons":
        url = f"https://cdn.simpleicons.org/{key}"
    else:
        url = key
        
    print(f"Downloading {name} from {url}...")
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req) as response:
            content = response.read()
            with open(dest_path, "wb") as f:
                f.write(content)
        print(f"  Successfully saved to {dest_path}")
        return True
    except Exception as e:
        print(f"  Error downloading {name}: {e}")
        # Try fallback if devicon failed
        if src_type == "devicon":
            fallback_url = f"https://cdn.simpleicons.org/{name}"
            print(f"  Trying fallback for {name} to {fallback_url}...")
            try:
                fallback_req = urllib.request.Request(fallback_url, headers=headers)
                with urllib.request.urlopen(fallback_req) as fallback_response:
                    content = fallback_response.read()
                    with open(dest_path, "wb") as f:
                        f.write(content)
                print(f"    Successfully saved fallback to {dest_path}")
                return True
            except Exception as fe:
                print(f"    Fallback also failed: {fe}")
        return False

def main():
    success_count = 0
    for name, src_type, key in icon_sources:
        if download_icon(name, src_type, key):
            success_count += 1
    print(f"\nDone! Downloaded {success_count} / {len(icon_sources)} icons.")

if __name__ == "__main__":
    main()
