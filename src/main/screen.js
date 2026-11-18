'use strict';
/**
 * Locally - screenshots and coordinate mapping.
 *
 * The model sees one display at a time. It answers with coordinates normalised to a 0..1000 grid
 * (0,0 = top-left of the screenshot). We map them back to real pixels like this:
 *   normalised -> DIP (Electron device-independent pixels, per display bounds)
 *   DIP        -> physical screen pixels with screen.dipToScreenPoint (Windows/Linux), which accounts
 *                 for each monitor's own scale factor (125%, 150%, mixed-DPI setups, negative origins).
 * The Windows input host is per-monitor DPI aware, so physical pixels land exactly.
 */
const { desktopCapturer, screen } = require('electron');

class ScreenService {
  constructor(getSettings, automation = null) {
    this.getSettings = getSettings;
    this.automation = automation;
    this.currentDisplayId = null;
    this.hooks = { before: null, after: null };
  }

  setAutomation(automation) { this.automation = automation; }
  setCaptureHooks(before, after) { this.hooks.before = before; this.hooks.after = after; }

  displays() {
    const primary = screen.getPrimaryDisplay();
    return screen.getAllDisplays().map((d, i) => ({
      index: i,
      id: d.id,
      label: d.label || ('Display ' + (i + 1)),
      primary: d.id === primary.id,
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
      rotation: d.rotation,
      physical: { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) }
    }));
  }

  resolveDisplay(target) {
    const all = screen.getAllDisplays();
    if (target !== undefined && target !== null && target !== '') {
      if (typeof target === 'number' && all[target]) return all[target];
      const byId = all.find((d) => String(d.id) === String(target));
      if (byId) return byId;
    }
    if (this.currentDisplayId !== null) {
      const cur = all.find((d) => d.id === this.currentDisplayId);
      if (cur) return cur;
    }
    const pref = this.getSettings().displayTarget;
    if (pref === 'cursor') return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    if (pref && pref !== 'primary') {
      const d = all.find((x) => String(x.id) === String(pref));
      if (d) return d;
    }
    return screen.getPrimaryDisplay();
  }

  currentDisplay() { return this.resolveDisplay(); }

  setCurrentDisplayByIndex(index) {
    const all = screen.getAllDisplays();
    const d = all[index];
    if (!d) throw new Error('There is no display #' + index + '. Available: 0..' + (all.length - 1));
    this.currentDisplayId = d.id;
    return d;
  }

  resetSession() { this.currentDisplayId = null; }

  displayIndex(d) {
    return screen.getAllDisplays().findIndex((x) => x.id === d.id);
  }

  /**
   * Captures a real screenshot of a display (or a specific shared window when kind === 'window').
   * @returns {{base64:string, mime:string, width:number, height:number, physical:{width,height}, display:object, index:number}}
   */
  async capture({ display, format = 'jpeg', maxWidth, sourceId, kind, sourceName } = {}) {
    const d = display || this.currentDisplay();
    const all = screen.getAllDisplays();
    let maxW = 0;
    let maxH = 0;
    for (const x of all) {
      maxW = Math.max(maxW, Math.round(x.bounds.width * x.scaleFactor));
      maxH = Math.max(maxH, Math.round(x.bounds.height * x.scaleFactor));
    }
    if (this.hooks.before) await this.hooks.before();
    let img = null;
    try {
      // On Windows, prefer direct 1:1 DPI-aware native GDI+ capture when capturing a display (sharper text & zero Chromium thumbnail blur/lag)
      if (process.platform === 'win32' && !sourceId && kind !== 'window' && this.automation && typeof this.automation.captureNative === 'function') {
        try {
          const physOrigin = screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y });
          const physW = Math.round(d.bounds.width * (d.scaleFactor || 1));
          const physH = Math.round(d.bounds.height * (d.scaleFactor || 1));
          const nat = await this.automation.captureNative(physOrigin.x, physOrigin.y, physW, physH, { png: format === 'png', grid: false });
          if (nat && nat.base64) {
            const { nativeImage } = require('electron');
            const candidate = nativeImage.createFromBuffer(Buffer.from(nat.base64, 'base64'));
            if (candidate && !candidate.isEmpty()) img = candidate;
          }
        } catch (_) { /* fall back cleanly to desktopCapturer */ }
      }
      if (!img) {
        let src = null;
        if (kind === 'window' && (sourceId || sourceName)) {
          const winSources = await desktopCapturer.getSources({
            types: ['window'],
            thumbnailSize: { width: Math.min(1920, maxW || 1920), height: Math.min(1080, maxH || 1080) },
            fetchWindowIcons: false
          }).catch(() => []);
          const sn = String(sourceName || '').toLowerCase();
          src = winSources.find((s) => s.id === sourceId && s.thumbnail && !s.thumbnail.isEmpty()) ||
            (sn ? winSources.find((s) => String(s.name || '').toLowerCase().includes(sn) && s.thumbnail && !s.thumbnail.isEmpty()) : null) ||
            null;
        }
        if (!src) {
          const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH }, fetchWindowIcons: false });
          if (!sources || !sources.length) throw new Error('No screen sources were returned by the OS. On macOS grant Screen Recording permission.');
          if (sourceId && kind !== 'window') {
            src = sources.find((s) => s.id === sourceId);
          }
          if (!src) {
            src = sources.find((s) => String(s.display_id) === String(d.id));
          }
          if (!src) {
            const idx = all.findIndex((x) => x.id === d.id);
            src = sources[idx] || sources[0];
          }
        }
        img = src.thumbnail;
      }
    } finally {
      if (this.hooks.after) await this.hooks.after();
    }
    if (!img || img.isEmpty()) {
      const msg = process.platform === 'win32'
        ? 'The screenshot came back empty. Make sure Windows is unlocked, no UAC prompt is active, and Brief was launched inside your interactive desktop session.'
        : process.platform === 'darwin'
          ? 'The screenshot came back empty. On macOS grant Screen Recording permission to Brief and restart it.'
          : 'The screenshot came back empty. On Linux use an X11 session or allow screen capture in your desktop portal.';
      throw new Error(msg);
    }
    const physical = img.getSize();
    const limit = Number(maxWidth || this.getSettings().screenshotMaxWidth || 3840);
    if (physical.width > limit) {
      const h = Math.round(physical.height * (limit / physical.width));
      img = img.resize({ width: limit, height: h, quality: 'best' });
    }
    const size = img.getSize();
    const buf = format === 'png' ? img.toPNG() : img.toJPEG(92);
    return {
      base64: buf.toString('base64'),
      mime: format === 'png' ? 'image/png' : 'image/jpeg',
      width: size.width,
      height: size.height,
      physical,
      display: d,
      index: all.findIndex((x) => x.id === d.id),
      takenAt: Date.now()
    };
  }

  /** Captures a high-res zoomed region from normalized (0..scale) box on the active display. */
  async captureRegion({ x1, y1, x2, y2, scale = 1000, grid = true } = {}) {
    const d = this.currentDisplay();
    const p1 = this.mapPoint(Math.min(x1, x2), Math.min(y1, y2), { display: d, scale });
    const p2 = this.mapPoint(Math.max(x1, x2), Math.max(y1, y2), { display: d, scale });
    const rx = p1.native.x;
    const ry = p1.native.y;
    const rw = Math.max(60, p2.native.x - p1.native.x);
    const rh = Math.max(40, p2.native.y - p1.native.y);
    if (this.hooks.before) await this.hooks.before();
    try {
      if (process.platform === 'win32' && this.automation && typeof this.automation.captureNative === 'function') {
        const nat = await this.automation.captureNative(rx, ry, rw, rh, { png: true, grid });
        if (nat && nat.base64) {
          return { base64: nat.base64, mime: nat.mime || 'image/png', width: rw, height: rh, regionNorm: { x1: p1.normalized.x, y1: p1.normalized.y, x2: p2.normalized.x, y2: p2.normalized.y } };
        }
      }
    } finally {
      if (this.hooks.after) await this.hooks.after();
    }
    // Fallback crop via Electron desktopCapturer
    const full = await this.capture({ display: d, format: 'png' });
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromBuffer(Buffer.from(full.base64, 'base64'));
    const cx = Math.max(0, Math.round((p1.normalized.x / scale) * full.width));
    const cy = Math.max(0, Math.round((p1.normalized.y / scale) * full.height));
    const cw = Math.max(40, Math.min(full.width - cx, Math.round(((p2.normalized.x - p1.normalized.x) / scale) * full.width)));
    const ch = Math.max(40, Math.min(full.height - cy, Math.round(((p2.normalized.y - p1.normalized.y) / scale) * full.height)));
    const cropped = img.crop({ x: cx, y: cy, width: cw, height: ch });
    return { base64: cropped.toPNG().toString('base64'), mime: 'image/png', width: cw, height: ch, regionNorm: { x1: p1.normalized.x, y1: p1.normalized.y, x2: p2.normalized.x, y2: p2.normalized.y } };
  }

  /** Lists available screens & non-Brief windows for the Third Eye Screen Share picker. */
  async listShareSources() {
    const isBrief = (n) => /^(?:brief(?:\s|$)|locally(?:\s|$)|brief desktop layer|brief status widget)/i.test(String(n || '').trim());
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 380, height: 220 },
      fetchWindowIcons: false
    }).catch(() => []);
    const screens = [];
    const windows = [];
    for (const s of sources) {
      const id = String(s.id || '');
      const name = String(s.name || '').trim();
      if (!name || isBrief(name)) continue;
      if (s.thumbnail && s.thumbnail.isEmpty()) continue;
      const item = {
        id,
        name,
        kind: id.startsWith('screen:') ? 'screen' : 'window',
        displayId: s.display_id || '',
        thumbnailDataUrl: 'data:image/jpeg;base64,' + s.thumbnail.toJPEG(68).toString('base64')
      };
      if (item.kind === 'screen') screens.push(item);
      else windows.push(item);
    }
    return { screens, windows: windows.slice(0, 24) };
  }

  /** Live Third Eye preview thumbnail for an active shared screen or window. */
  async captureSharePreview(source) {
    if (!source || !source.id) return null;
    const isWin = source.kind === 'window' || String(source.id).startsWith('window:');
    const sources = await desktopCapturer.getSources({
      types: [isWin ? 'window' : 'screen'],
      thumbnailSize: { width: 640, height: 380 },
      fetchWindowIcons: false
    }).catch(() => []);
    let match = sources.find((s) => s.id === source.id && s.thumbnail && !s.thumbnail.isEmpty());
    if (!match && source.name) {
      const sn = String(source.name).toLowerCase();
      match = sources.find((s) => String(s.name || '').toLowerCase().includes(sn) && s.thumbnail && !s.thumbnail.isEmpty());
    }
    if (!match) return null;
    return {
      id: match.id,
      name: match.name || source.name,
      kind: isWin ? 'window' : 'screen',
      dataUrl: 'data:image/jpeg;base64,' + match.thumbnail.toJPEG(68).toString('base64'),
      takenAt: Date.now()
    };
  }

  /** A small preview (data URL) for approval prompts and the log. */
  async preview(maxWidth = 520) {
    const shot = await this.capture({ maxWidth, format: 'jpeg' });
    return { dataUrl: 'data:image/jpeg;base64,' + shot.base64, display: shot.display, width: shot.width, height: shot.height };
  }

  /**
   * Maps a normalised point on a display to:
   *  - dip   : Electron DIP coordinates (used by the cursor overlay window)
   *  - native: what the OS input backend expects (physical px on Windows/Linux, points on macOS)
   */
  mapPoint(nx, ny, { display, scale = 1000 } = {}) {
    const d = display || this.currentDisplay();
    const cx = clamp(Number(nx), 0, scale - 1);
    const cy = clamp(Number(ny), 0, scale - 1);
    if (!isFinite(cx) || !isFinite(cy)) throw new Error('Coordinates must be numbers between 0 and ' + scale + '.');
    const dip = {
      x: d.bounds.x + (cx / scale) * d.bounds.width,
      y: d.bounds.y + (cy / scale) * d.bounds.height
    };
    let native;
    if (process.platform === 'darwin') {
      native = { x: Math.round(dip.x), y: Math.round(dip.y) };
    } else {
      const p = screen.dipToScreenPoint({ x: Math.round(dip.x), y: Math.round(dip.y) });
      native = { x: Math.round(p.x), y: Math.round(p.y) };
    }
    return { dip: { x: Math.round(dip.x), y: Math.round(dip.y) }, native, display: d, normalized: { x: cx, y: cy, scale } };
  }

  /** Converts a native/physical point back to DIP (for the overlay when reading the real cursor). */
  nativeToDip(x, y) {
    if (process.platform === 'darwin') return { x, y };
    return screen.screenToDipPoint({ x, y });
  }

  describe() {
    return this.displays().map((d) => 'Display #' + d.index + (d.primary ? ' (primary)' : '') + ': ' + d.physical.width + 'x' + d.physical.height +
      ' px at ' + Math.round(d.scaleFactor * 100) + '% scaling, origin (' + d.bounds.x + ',' + d.bounds.y + ') DIP').join('\n');
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

module.exports = { ScreenService };
