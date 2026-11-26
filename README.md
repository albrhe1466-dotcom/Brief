<p align="center">
  <img src="assets/brief-wordmark.png" alt="Brief AI Logo" width="320">
</p>

<h1 align="center">Brief AI · v2.1.1-beta</h1>

<p align="center">
  <strong>Private Multi-Platform AI Assistant &amp; Live Screen Agent for Windows, Linux &amp; Android Phones/Tablets</strong><br>
  Sees, clicks, types, codes, and verifies across real apps with custom provider cursors, 150-frame live vision, Clawd in Brief Code, and encrypted local API keys.
</p>

---

## Download & Install (`v2.1.1-beta`)

- **Official Website (GitHub Pages):** https://albrhe1466-dotcom.github.io/Brief/
- **Windows 10 / 11 Setup Wizard:** [Brief-Setup.exe](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/Brief-Setup.exe)
- **Windows Full Portable Bundle:** [brief-package.zip](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/brief-package.zip)
- **Android Phones & Tablets APK (Samsung, Honor MagicOS, Pixel, Xiaomi):** [Brief-Android-v2.1.1-beta.apk](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/Brief-Android-v2.1.1-beta.apk)
- **Linux Desktop Packages (x64 & ARM64):**
  - [Brief-Linux-x64.deb](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/Brief-Linux-x64.deb) · [Brief-Linux-x64.AppImage](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/Brief-Linux-x64.AppImage) · [Brief-Linux-x64.tar.gz](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/Brief-Linux-x64.tar.gz)
  - [Brief-Linux-arm64.deb](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/Brief-Linux-arm64.deb) · [Brief-Linux-arm64.tar.gz](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/Brief-Linux-arm64.tar.gz)

## What's New in `v2.1.1-beta`

- **Clawd Pixel Mascot Animations in Brief Code:** Exact pixel-art GIFs of **Clawd** (pulling out his laptop to code & playing soccer with his ball) perched seamlessly on Brief Code's input bar with daily/random rotation and 1-tap switching.
- **Clean Work-Only Permission Controls Across All 4 AIs:** Regular Chat mode hides permission controls completely across Gemini, OpenAI, Claude & OpenRouter; Work / Brief Code / Task shows strictly **Ask for permission** or **Full access**.
- **Automatic Touch Screen Typing & Ultra-HD `brief^Ai` Brand Identity:** Automatic touch-target highlighting & live letter-by-letter typing under the hood alongside crisp `1024×1024` white-on-black `brief^Ai` icons.
- **Authentic Claude 4-State `#d9693f` Animations & Official Emblem:** Exact 8-frame organic hand-drawn Claude starburst, untouched `200×200` 3D Orbiting Dots, solid wave/pulse circles, and official Claude Code pixel emblem.

## Supported AI Providers (Bring Your Own Key)

- **Google Gemini** (`AIza...` / `AQ...`) — Gemini 3.5 Flash-Lite, Gemini 3.8 Flash, Gemini 4 Carbon
- **OpenAI** (`sk-...`) — Auto, GPT-6 Luna, GPT-6.1 Terra, GPT-6.2 Sol, GPT-6.2 Astra
- **Anthropic Claude** (`sk-ant-...`) — Claude Haiku 4.5, Claude Sonnet 4.6, Claude Opus 4.7 & Brief Code (`</>`)
- **OpenRouter** (`sk-or-...`)

Keys are encrypted locally using OS keychain / Windows DPAPI / Android Hardware Keystore (AES-256-GCM) and never leave your device except for requests to your chosen provider.

## Local Development

```powershell
npm install --no-fund --no-audit
npm run check
npm start
```
