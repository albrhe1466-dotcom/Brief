# Brief

Brief — Private Windows desktop AI agent that sees, clicks, types, builds, and verifies across real apps with multi-agent reasoning, native OCR vision, and a native Windows Setup installer.

## Download & Install (Windows 10 / 11)

- **Download Webpage (GitHub Pages):** https://albrhe1466-dotcom.github.io/Brief/
- **Direct Windows Installer:** [Brief-Setup.exe](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/Brief-Setup.exe)
- **Full Portable Bundle:** [brief-package.zip](https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/brief-package.zip)

Opening `Brief-Setup.exe` launches the native Windows Setup Wizard, downloads Brief, adds Desktop & Start Menu shortcuts, and starts Brief's animated 3-slide first-run onboarding (`Welcome -> Your Name -> Auto-Detect & Confirm API Key`).

## Supported AI Providers (Bring Your Own Key)

- **Google Gemini** (`AIza...` / `AQ...`)
- **OpenAI** (`sk-...`)
- **Anthropic Claude** (`sk-ant-...`)
- **OpenRouter** (`sk-or-...`)

Keys are encrypted locally using OS keychain / Windows DPAPI protection and never leave your device except for requests to your chosen provider.

## Local Development

```powershell
npm install --no-fund --no-audit
npm start
```

### Build Windows Installer & Run Local Download Website

```powershell
npm run check
npm run build:installer
npm run site
```
