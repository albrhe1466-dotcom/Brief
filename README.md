<p align="center">
  <img src="assets/brief-wordmark.png" alt="Brief AI Logo" width="320">
</p>

<h1 align="center">Brief AI · v2.1.3-beta</h1>

<p align="center">
  <strong>Private Multi-Platform AI Assistant &amp; Live Screen Agent for Windows, Linux &amp; Android Phones/Tablets</strong><br>
  Sees, clicks, types, codes, and verifies across real apps with custom provider cursors, 150-frame live vision, Clawd in Brief Code, and encrypted local API keys.
</p>

---

## Download & Install (`v2.1.3-beta`)

- **Official Website (GitHub Pages):** https://albrhe1466-dotcom.github.io/Brief/
- **Windows 10 / 11 Setup Wizard:** [Brief-Setup.exe](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/Brief-Setup.exe)
- **Windows Full Portable Bundle:** [brief-package.zip](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/brief-package.zip)
- **Android Phones & Tablets APK (Samsung One UI, Honor MagicOS, ColorOS, Pixel, Xiaomi):** [Brief-Android-v2.1.3-beta.apk](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/Brief-Android-v2.1.3-beta.apk)
- **Linux Desktop Packages (x64 & ARM64):**
  - [Brief-Linux-x64.deb](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/Brief-Linux-x64.deb) · [Brief-Linux-x64.AppImage](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/Brief-Linux-x64.AppImage) · [Brief-Linux-x64.tar.gz](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/Brief-Linux-x64.tar.gz)
  - [Brief-Linux-arm64.deb](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/Brief-Linux-arm64.deb) · [Brief-Linux-arm64.tar.gz](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/Brief-Linux-arm64.tar.gz)

## What's New in `v2.1.3-beta`

- **Centered Portrait & Landscape Android UI (Zero Notch Crowding & Zero Bottom Chin):** Native `WindowInsets` cutout/system-bar handling keeps Brief clear of camera notches, removes the bottom chin, and centers Welcome & Onboarding cleanly in both portrait and landscape on phones & tablets.
- **Smart Hybrid Typing & Live OEM Enter / Search Detection:** Automatically combines fresh-node text input, physical touch-keyboard key tapping, and paste fallback while inspecting the live keyboard window to locate the exact **Search / Enter / Go / Send** button across **Samsung One UI, Oppo/Realme ColorOS, Honor MagicOS & Gboard**.
- **Full Multi-Step Vision Across All 4 AIs (Fastest & Strongest Models):** Seamless turn-alternation & `[KEYBOARD_ENTER_KEY]` UI mapping across **Gemini, OpenAI, Claude & OpenRouter**.
- **Clawd Pixel Mascot GIFs & Direct In-App Updates:** Seamless Clawd coding & soccer GIFs in Brief Code plus 1-tap direct Android `FileProvider` updates.

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
