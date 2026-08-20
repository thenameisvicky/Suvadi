# Suvadi (சுவடி)

> Save your GPT conversations locally.

Suvadi is a lightweight, secure Chrome extension designed to save and catalog your ChatGPT conversation histories locally.

---

## Features

- **Red Glassmorphic Design:** A premium dark glassmorphism layout with blur backdrops and neon accents.
- **Offline First:** Save individual conversations as `.md` markdown files inside a local `helm_vault/` directory in your downloads folder.
- **Zero Privacy Leakage:** Stores all your records locally inside your browser's private database (`chrome.storage.local`).
- **State Persistence:** Refresh the page mid-conversation without losing track of your active recording session.
- **History Loader:** Inject previously saved chats back into ChatGPT in milliseconds using direct Lexical insertion.

---

## Sideloading / Installation

1. Clone or download this repository as a `.zip` archive.
2. Open Google Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle switch in the top-right corner.
4. Click **Load unpacked** (top-left button).
5. Select the repository folder (the folder containing `manifest.json`).
