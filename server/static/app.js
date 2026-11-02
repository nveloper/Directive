(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ---- language ----
  // The interface follows the system language: Korean when it is Korean,
  // English otherwise. Strings are written in English and looked up in the
  // Korean table (i18n.js); anything missing there simply stays English.
  // Names people choose - the app's, departments', tasks' - are never
  // translated. {name} in a string is filled from params.
  var LANG = (function () {
    var l = ((navigator.languages && navigator.languages[0]) || navigator.language || navigator.userLanguage || 'en').toLowerCase();
    return l.indexOf('ko') === 0 ? 'ko' : 'en';
  })();
  var KO = window.DIRECTIVE_KO || {};
  try { document.documentElement.lang = LANG; } catch (e) {}

  function T(text, params) {
    var out = LANG === 'ko' && Object.prototype.hasOwnProperty.call(KO, text) ? KO[text] : text;
    if (params) out = out.replace(/\{(\w+)\}/g, function (m, k) { return params[k] !== undefined ? params[k] : m; });
    return out;
  }

  // Error messages come from the server in English. Fixed ones are looked up
  // like any string; the few with a number or detail in them are matched by
  // shape.
  var KO_PATTERNS = window.DIRECTIVE_KO_PATTERNS || [];
  function TE(message) {
    var m = String(message || '');
    if (LANG !== 'ko') return m;
    if (Object.prototype.hasOwnProperty.call(KO, m)) return KO[m];
    for (var i = 0; i < KO_PATTERNS.length; i++) {
      var hit = KO_PATTERNS[i][0].exec(m);
      if (hit) return KO_PATTERNS[i][1].replace(/\$(\d)/g, function (_, n) { return hit[Number(n)] || ''; });
    }
    return m;
  }

  var NARROW_QUERY = '(max-width: 860px)';
  function isNarrowScreen() {
    return !!(window.matchMedia && window.matchMedia(NARROW_QUERY).matches);
  }

  // Material You derives its tonal palettes in HCT (hue/chroma/tone), a
  // perceptually-uniform space — equal tone numbers look equally light
  // regardless of hue. Plain HSL doesn't have that property (its "lightness"
  // is a poor match for how light a color actually looks — brown/orange
  // hues in particular end up far lighter and more saturated than blues or
  // purples at the same L), so accent colors like brown rendered "wrong"
  // next to the others. OKLab/OKLCH has the same perceptual-uniformity
  // property as HCT and is simple to compute without a color-science
  // library, so we use it in place of HSL.
  function srgbToLinear01(c) { c = clamp(c, 0, 1); return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function linearToSrgb01(c) { c = clamp(c, 0, 1); return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

  function linearSrgbToOklab(r, g, b) {
    var l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    var m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    var s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    var l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
    return {
      L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
      a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
      b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    };
  }

  function oklabToLinearSrgb(L, a, b) {
    var l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    var m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    var s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    var l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    return {
      r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    };
  }

  // hex -> {L (0-1 perceptual lightness), C (chroma), H (hue, degrees)}
  function hexToOklch(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) { hex = hex.split('').map(function (ch) { return ch + ch; }).join(''); }
    var r = srgbToLinear01(parseInt(hex.substring(0, 2), 16) / 255);
    var g = srgbToLinear01(parseInt(hex.substring(2, 4), 16) / 255);
    var b = srgbToLinear01(parseInt(hex.substring(4, 6), 16) / 255);
    var lab = linearSrgbToOklab(r, g, b);
    return { L: lab.L, C: Math.sqrt(lab.a * lab.a + lab.b * lab.b), H: Math.atan2(lab.b, lab.a) * 180 / Math.PI };
  }

  // {L, C, H} -> hex, reducing chroma until the color re-enters the sRGB
  // gamut (out-of-gamut OKLCH values are common — sRGB can't hold every
  // hue at every chroma/lightness combination).
  function oklchToHex(L, C, H) {
    L = clamp(L, 0, 1);
    C = Math.max(C, 0);
    var hr = H * Math.PI / 180;
    var lin;
    for (var i = 0; i < 30; i++) {
      lin = oklabToLinearSrgb(L, C * Math.cos(hr), C * Math.sin(hr));
      if (lin.r >= -0.0005 && lin.r <= 1.0005 && lin.g >= -0.0005 && lin.g <= 1.0005 && lin.b >= -0.0005 && lin.b <= 1.0005) break;
      C *= 0.92;
    }
    function h2(n) { var v = Math.round(linearToSrgb01(n) * 255); var s = v.toString(16); return s.length === 1 ? '0' + s : s; }
    return '#' + h2(lin.r) + h2(lin.g) + h2(lin.b);
  }

  function computeInitials(name) {
    var parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    // A Korean name is one block of syllables; its first one is the initial
    // people expect, and two of them do not fit a small circle.
    if (/^[\u3131-\u318E\uAC00-\uD7A3]/.test(parts[0])) return parts[0].charAt(0);
    if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  // Renders `fallbackHtml` (a letter avatar/icon) with a same-sized photo laid
  // over it; if the photo URL 404s (no photo uploaded), it removes itself and
  // the letter shows through underneath. Avoids fetching a "does this user
  // have a photo" flag up front.
  function withImageFallback(src, fallbackHtml, sizePx, radiusCss, wrapperAttrs) {
    return '<div ' + (wrapperAttrs || '') + ' style="position:relative; width:' + sizePx + 'px; height:' + sizePx + 'px; flex-shrink:0;">'
      + fallbackHtml
      + '<img src="' + esc(src) + '" alt="" style="position:absolute; inset:0; width:100%; height:100%; border-radius:' + radiusCss + '; object-fit:cover; pointer-events:none;" onerror="this.remove()">'
      + '</div>';
  }

  function brandIconHtml(bg, fg, sizePx, mode) {
    if (mode === true) mode = 'edit';
    if (mode === false || !mode) mode = 'none';
    var letter = esc((state.appName || 'D').charAt(0).toUpperCase());
    var fallback = '<div style="width:' + sizePx + 'px; height:' + sizePx + 'px; border-radius:' + Math.round(sizePx * 0.28) + 'px; background:' + bg + '; color:' + fg + '; display:flex; align-items:center; justify-content:center; font-weight:600; font-size:' + Math.round(sizePx * 0.42) + 'px;">' + letter + '</div>';
    var attrs = mode === 'edit'
      ? 'class="interactive brand-icon" data-action="toggleBrandMenu" title="' + T('Change app icon') + '" aria-haspopup="menu" aria-expanded="' + (state.brandOpen ? 'true' : 'false') + '"'
      : (mode === 'guide'
        ? 'class="interactive brand-icon" data-action="openGuide" title="' + T('How to use this app') + '"'
        : 'class="brand-icon"');
    return withImageFallback('/api/settings/icon?v=' + state.appIconVersion, fallback, sizePx, Math.round(sizePx * 0.28) + 'px', attrs);
  }

  function avatarHtml(bg, fg, sizePx) {
    var fallback = '<div style="width:' + sizePx + 'px; height:' + sizePx + 'px; border-radius:50%; background:' + bg + '; color:' + fg + '; display:flex; align-items:center; justify-content:center; font-size:' + Math.round(sizePx * 0.38) + 'px; font-weight:600;">' + esc(computeInitials(state.user.displayName)) + '</div>';
    return withImageFallback('/api/users/' + state.user.id + '/avatar?v=' + state.avatarVersion, fallback, sizePx, '50%');
  }

  // ---- image upload (app icon, avatars) ----
  function pickImage(callback) {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png,image/jpeg,image/webp,image/gif';
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', function () {
      var file = inp.files && inp.files[0];
      document.body.removeChild(inp);
      if (!file) return;
      if (file.size > 1024 * 1024) { window.alert(T('Image must be under 1MB.')); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result);
        var comma = result.indexOf(',');
        var mime = result.slice(5, comma).split(';')[0];
        callback({ mime: mime, data: result.slice(comma + 1) });
      };
      reader.readAsDataURL(file);
    });
    inp.click();
  }

  function renderDefaultFaviconDataUrl() {
    var c = deriveColors(state.accent, isDarkActive());
    var letter = (state.appName || 'D').charAt(0).toUpperCase();
    var canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    var ctx = canvas.getContext('2d');
    var r = 16;
    ctx.fillStyle = c.primaryContainer;
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.arcTo(64, 0, 64, 64, r); ctx.arcTo(64, 64, 0, 64, r);
    ctx.arcTo(0, 64, 0, 0, r); ctx.arcTo(0, 0, 64, 0, r); ctx.closePath(); ctx.fill();
    ctx.fillStyle = c.onPrimaryContainer;
    ctx.font = '700 36px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, 32, 36);
    return canvas.toDataURL('image/png');
  }

  function refreshFavicon() {
    var link = document.getElementById('favicon');
    if (!link) return;
    var url = '/api/settings/icon?v=' + state.appIconVersion;
    var probe = new Image();
    probe.onload = function () { link.href = url; };
    probe.onerror = function () { link.href = renderDefaultFaviconDataUrl(); };
    probe.src = url;
  }

  // The palette has two halves. The accent - the one colour a person picks -
  // is derived here at run time, and is spent on very little: the primary
  // button, the selected item and the focus ring. Everything else is fixed:
  // near-neutral surfaces with no tint of the accent in them, and status,
  // priority and avatar colours that mean the same thing whatever the accent
  // is. (The role names are Material's, kept so the markup did not have to
  // change; what they hold is not.)
  var NEUTRAL = {
    light: {
      surface: '#FFFFFF',              // panels, cards, dialogs
      surfaceContainerLow: '#F7F7F5',  // the canvas behind them, sidebars
      surfaceContainer: '#F1F1EF',     // menus, table headers
      surfaceContainerHigh: '#EAEAE7', // hover, counts, tracks
      surfaceVariant: '#F1F1EF',       // tags and code
      onSurface: '#1B1B1A',            // text
      onSurfaceVariant: '#5E5E59',     // secondary text
      textMuted: '#8E8E88',            // placeholders, quiet icons
      outline: '#CFCFCA',              // field borders
      outlineVariant: '#E4E4E0',       // dividers
      error: '#DC2626',
      errorContainer: '#FDECEC',
      onErrorContainer: '#9F1C1C',
      success: '#16A34A',
      warning: '#B45309',
      warningContainer: '#FDF1DC',
      onWarningContainer: '#8A4B05'
    },
    dark: {
      surface: '#17171A',
      surfaceContainerLow: '#0F0F11',
      surfaceContainer: '#1E1E22',
      surfaceContainerHigh: '#27272C',
      surfaceVariant: '#222226',
      onSurface: '#EDEDEF',
      onSurfaceVariant: '#A1A1AA',
      textMuted: '#71717A',
      outline: '#3A3A42',
      outlineVariant: '#2A2A30',
      error: '#F87171',
      errorContainer: '#3A1517',
      onErrorContainer: '#FCA5A5',
      success: '#22C55E',
      warning: '#F59E0B',
      warningContainer: '#33250D',
      onWarningContainer: '#FCD34D'
    }
  };

  // Status colours: grey to do, blue in progress, amber in review, green
  // done, red overdue. Each has a dot colour, and a tint and a text colour
  // for the label it sits in.
  var STATUS_COLORS = {
    light: {
      todo:       { dot: '#8E8E88', bg: '#EFEFEC', color: '#4A4A46' },
      inprogress: { dot: '#2F6FEB', bg: '#E8EFFD', color: '#1A4DB8' },
      review:     { dot: '#D97706', bg: '#FDF1DC', color: '#8A4B05' },
      done:       { dot: '#16A34A', bg: '#E4F4E9', color: '#13703A' },
      overdue:    { dot: '#DC2626', bg: '#FDECEC', color: '#A61B1B' }
    },
    dark: {
      todo:       { dot: '#8B8B94', bg: '#26262B', color: '#BDBDC4' },
      inprogress: { dot: '#5B8DEF', bg: '#172340', color: '#93B4F6' },
      review:     { dot: '#F59E0B', bg: '#33250D', color: '#FBC560' },
      done:       { dot: '#22C55E', bg: '#10291A', color: '#6EE19A' },
      overdue:    { dot: '#F87171', bg: '#3A1517', color: '#FCA5A5' }
    }
  };
  var PRIORITY_COLORS = {
    light: { High: '#EA580C', Medium: '#5E5E59', Low: '#B4B4AE' },
    dark: { High: '#FB923C', Medium: '#A1A1AA', Low: '#5C5C66' }
  };

  function deriveColors(seed, dark) {
    var base = hexToOklch(seed);
    var h = base.H, C = base.C;
    // tone: 0-100, mapped straight onto OKLCH lightness, which is perceptually
    // even across hues - a yellow and a blue at the same tone look as light
    // as each other, so any accent lands at a readable lightness.
    function tone(hue, chroma, t) { return oklchToHex(t / 100, chroma, hue); }
    var n = NEUTRAL[dark ? 'dark' : 'light'];
    var c = {};
    Object.keys(n).forEach(function (k) { c[k] = n[k]; });
    if (!dark) {
      c.primary = tone(h, C, 50);
      c.onPrimary = '#FFFFFF';
      c.primaryContainer = tone(h, Math.min(C * 0.3, 0.045), 95.5);
      c.onPrimaryContainer = tone(h, Math.min(C, 0.16), 38);
    } else {
      c.primary = tone(h, C, 74);
      c.onPrimary = tone(h, Math.min(C * 0.3, 0.04), 16);
      c.primaryContainer = tone(h, Math.min(C * 0.45, 0.07), 27);
      c.onPrimaryContainer = tone(h, Math.min(C * 0.6, 0.1), 88);
    }
    // The old secondary and tertiary roles were further shades of the accent.
    // Where they marked something done they are now the success green, where
    // they marked a warning the amber, and elsewhere a plain neutral.
    c.secondary = c.success;
    c.onSecondary = dark ? '#0F0F11' : '#FFFFFF';
    c.secondaryContainer = c.surfaceContainerHigh;
    c.onSecondaryContainer = c.onSurface;
    c.tertiary = c.warning;
    c.tertiaryContainer = c.warningContainer;
    c.onTertiaryContainer = c.onWarningContainer;
    c.dark = dark;
    return c;
  }

  // Letter avatars take one of eight quiet hues from the name, so a person
  // keeps their colour everywhere and it never follows the accent.
  var AVATAR_HUES = [25, 70, 135, 175, 215, 255, 300, 345];
  function avatarColors(name, dark) {
    var s = String(name || ''), hash = 0;
    for (var i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
    var hue = AVATAR_HUES[Math.abs(hash) % AVATAR_HUES.length];
    return dark
      ? { bg: oklchToHex(0.34, 0.06, hue), color: oklchToHex(0.88, 0.07, hue) }
      : { bg: oklchToHex(0.92, 0.045, hue), color: oklchToHex(0.38, 0.09, hue) };
  }

  var TAB_ORDER = ['all', 'todo', 'inprogress', 'review', 'done', 'overdue'];
  var TAB_LABELS = { all: T('All'), todo: T('To Do'), inprogress: T('In Progress'), review: T('Review'), done: T('Done'), overdue: T('Overdue') };
  var STATUS_META = {
    todo: { label: T('To Do') }, inprogress: { label: T('In Progress') }, review: { label: T('Review') },
    done: { label: T('Done') }, overdue: { label: T('Overdue') }
  };
  // 'overdue' is not a status a task can be saved with - the server derives it
  // from the due date. These are the states a person can choose in the editor.
  var EDITABLE_STATUSES = ['todo', 'inprogress', 'review', 'done'];
  // Dates are written the reader's way: "Sep 24" or "9월 24일".
  var LOCALE = LANG === 'ko' ? 'ko-KR' : 'en-US';
  function shortDate(d) { return d.toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' }); }
  var CONTENT_OUT_MS = 90, CONTENT_IN_MS = 140, MODAL_CLOSE_MS = 160;
  var ACCENT_PRESETS = ['#3451D1', '#0F766E', '#7C3AED', '#C2410C', '#BE185D'];
  var ICON = {
    listView: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 6h12M4 10h12M4 14h12"></path></svg>',
    gridView: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="6" height="6" rx="1.3"></rect><rect x="11" y="3" width="6" height="6" rx="1.3"></rect><rect x="3" y="11" width="6" height="6" rx="1.3"></rect><rect x="11" y="11" width="6" height="6" rx="1.3"></rect></svg>',
    chevronLeft: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5l-5 5 5 5"></path></svg>',
    chevronRight: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 5l5 5-5 5"></path></svg>',
    filter: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h14M6 10h8M8.5 15h3"></path></svg>',
    plus: '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 4v12M4 10h12"></path></svg>',
    close: '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"></path></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.5l3.5 3.5L15.5 6.5"></path></svg>',
    more: '<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="4.5" cy="10" r="1.5"></circle><circle cx="10" cy="10" r="1.5"></circle><circle cx="15.5" cy="10" r="1.5"></circle></svg>',
    copy: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="9" height="9" rx="1.5"></rect><path d="M4 13V5a1 1 0 0 1 1-1h8"></path></svg>',
    themeLight: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10" cy="10" r="4"></circle><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.6 4.6l1.4 1.4M14 14l1.4 1.4M4.6 15.4l1.4-1.4M14 6l1.4-1.4"></path></svg>',
    themeDark: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 12.3A7 7 0 1 1 7.7 3.5a5.5 5.5 0 0 0 8.8 8.8Z"></path></svg>',
    themeSystem: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10" cy="10" r="7"></circle><path d="M10 3a7 7 0 0 1 0 14Z" fill="currentColor" stroke="none"></path></svg>',
    // An eyedropper: the accent button opens the colour choices rather than
    // showing the colour, which the whole interface already does.
    eyedropper: '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.3 2.9a2.1 2.1 0 0 1 3 3l-1.6 1.6.8.8-1.4 1.4-4.8-4.8 1.4-1.4.8.8z"></path><path d="M10.5 6.3 4.2 12.6a1.6 1.6 0 0 0-.4.8l-.5 2.6a.6.6 0 0 0 .7.7l2.6-.5a1.6 1.6 0 0 0 .8-.4l6.3-6.3"></path></svg>',
    hamburger: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 5.5h14M3 10h14M3 14.5h14"></path></svg>',
    calendarView: '<svg width="19" height="19" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="14" height="12" rx="2"></rect><path d="M3 8.5h14M7 2.5v4M13 2.5v4"></path></svg>',
    search: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="9" cy="9" r="6"></circle><path d="M17 17l-4-4"></path></svg>',
    repeat: '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V8a3 3 0 0 1 3-3h9l-2.5-2.5M16 11v1a3 3 0 0 1-3 3H4l2.5 2.5"></path></svg>',
    checklist: '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5.5l1.5 1.5L7 4.5M3 12.5l1.5 1.5L7 11.5M10 6h7M10 13h7"></path></svg>',
    trash: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M8 6V4.5h4V6M5.5 6l.8 10a1 1 0 0 0 1 .9h5.4a1 1 0 0 0 1-.9l.8-10"></path></svg>'
  };

  var state = {
    user: null,
    authView: 'login',
    authError: '',
    authNotice: '',
    setupRequired: false,
    authForm: { username: '', password: '', displayName: '' },

    users: [],
    members: [],
    comments: [],
    commentDraft: '',
    // @mention picker under the comment box: the partial name typed after
    // "@" and which suggestion is highlighted.
    mention: null,
    checklist: [],
    checklistDraft: '',
    extraTasks: {},
    notifications: [],
    notifUnread: 0,
    bellTab: 'mine',
    desktopAlerts: loadDesktopAlerts(),
    snackbar: null,
    trash: [],
    trashModalPhase: 'closed',
    appPasswords: [],
    appPwName: '',
    appPwCreated: null,
    appPwModalPhase: 'closed',
    backups: null,
    backupForm: { enabled: false, time: '03:00', keep: 14 },
    backupModalPhase: 'closed',
    backupBusy: false,
    reminders: null,
    reminderForm: { enabled: true, time: '09:00' },
    reminderModalPhase: 'closed',
    detailTaskId: null,
    detailTask: null,
    detailPhase: 'closed',
    attachments: [],
    uploading: 0,
    dragOver: false,
    lightbox: null,
    iconPickerOpen: false,
    iconPickerClosing: false,
    openSelect: '',
    selectClosing: '',
    selectIndex: 0,
    passwordModalPhase: 'closed',
    pwForm: { current: '', next: '', confirm: '' },
    pwError: '',
    resetResult: null,
    usersModalPhase: 'closed',
    guideModalPhase: 'closed',
    displayNameDraft: '',

    accent: '#3451D1',
    accentPickerPhase: 'closed',
    themeMode: 'system',
    appName: 'Directive',
    appNameDraft: 'Directive',
    appIconVersion: Date.now(),
    avatarVersion: Date.now(),
    expanded: {},
    expandAnim: {},
    selectedNode: 'all',
    activeTab: 'all',
    contentAnim: 'settled',
    departments: [],
    tasks: [],
    todayTasks: [],
    activity: [],
    taskMeta: { page: 1, pageSize: 6, total: 0, totalPages: 1, statusCounts: {} },
    summary: { all: 0, mine: 0, trash: 0, byDept: {} },
    tasksLoading: false,
    activitySeen: loadActivitySeen(),
    copiedToken: '',
    // The subscribe links are set up once and then rarely looked at, so the
    // list starts folded on every screen.
    feedsOpen: false,
    searchQuery: '',
    viewMode: 'list',
    viewToggleAnim: null,
    page: 1,
    pageSize: 6,
    filterOpen: false,
    filterPriority: { High: true, Medium: true, Low: true },
    filterCalendar: 'all',
    filterAssignee: '',
    taskSort: loadTaskSort(),
    notifOpen: false,
    brandOpen: false,
    accountOpen: false,
    dropdownClosing: '',
    mobileNavOpen: false,
    mobileNavAnim: null,
    mobileCalendarOpen: false,
    mobileCalendarAnim: null,
    mobileSearchOpen: false,
    mobileSearchClosing: false,
    editingTaskId: null,
    newTaskModalPhase: 'closed',
    addDeptModalPhase: 'closed',
    mappingModalPhase: 'closed',
    newTaskForm: blankTaskForm(''),
    newDeptForm: { name: '', parentId: '' },
    mappingForm: { deptId: '', name: '', calendarList: '', tag: '' },
    justAddedTaskId: null
  };

  var nav = { nodeTarget: state.selectedNode, nodeToken: 0, tabTarget: state.activeTab, tabToken: 0, taskToken: 0, addDeptToken: 0, mappingToken: 0, accentToken: 0, mobileNavToken: 0, mobileCalendarToken: 0 };

  try {
    var savedTheme = localStorage.getItem('directive_theme_mode');
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') state.themeMode = savedTheme;
    var savedAccent = localStorage.getItem('directive_accent');
    if (/^#[0-9a-fA-F]{6}$/.test(savedAccent || '')) state.accent = savedAccent;
  } catch (e) {}

  function isDarkActive() {
    if (state.themeMode === 'dark') return true;
    if (state.themeMode === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  // ---- API client ----
  // Identifies this tab. The server puts it on the event it broadcasts, so the
  // tab that caused a change does not refetch what it already applied.
  var CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

  function api(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: { 'X-Client-Id': CLIENT_ID } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (res) {
      if (res.status === 204) return null;
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(TE((data && data.error) || ('Request failed (' + res.status + ')')));
          err.status = res.status;
          if (data && data.dependents) err.dependents = data.dependents;
          throw err;
        }
        return data;
      });
    });
  }

  // The bell used to hold a local echo of your own clicks: it never showed
  // anyone else's work and emptied itself on reload. It now shows the server's
  // activity feed, and "unread" is simply everything newer than the last time
  // this browser looked.
  var ACTIVITY_SEEN_KEY = 'directive_activity_seen';

  function loadActivitySeen() {
    try { return localStorage.getItem(ACTIVITY_SEEN_KEY) || ''; } catch (e) { return ''; }
  }

  function loadActivity() {
    return api('GET', '/api/activity?limit=60').then(function (a) {
      state.activity = a || [];
    }).catch(function () { state.activity = []; });
  }

  function unreadActivityCount() {
    if (!state.activitySeen) return state.activity.length;
    var seen = state.activitySeen;
    return state.activity.filter(function (a) { return a.at > seen; }).length;
  }

  function markActivitySeen() {
    var newest = state.activity.length ? state.activity[0].at : new Date().toISOString();
    try { localStorage.setItem(ACTIVITY_SEEN_KEY, newest); } catch (e) {}
    setState({ activitySeen: newest });
  }

  // "Ada created task Refactor the payments module". The server stores the
  // verb in English; in Korean the sentence is rebuilt from a template for
  // that verb and subject, so records already in the database read right too.
  var KO_ACTIVITY = window.DIRECTIVE_KO_ACTIVITY || {};
  function activityLine(a) {
    var mine = a.actorId && state.user && a.actorId === state.user.id;
    if (LANG === 'ko') {
      var verb = a.verb, file = '';
      var fm = /^(attached|removed) (.+) (to|from)$/.exec(verb);
      if (fm) { verb = fm[1] + ' file'; file = fm[2]; }
      var tpl = KO_ACTIVITY[verb + '|' + a.subject];
      if (tpl) {
        var summary = a.summary;
        if (a.subject === 'due-date reminders') summary = summary === 'off' ? '끔' : summary.replace(/^daily at (\d\d:\d\d)$/, '매일 $1');
        if (a.subject === 'automatic backups') summary = summary === 'off' ? '끔' : summary.replace(/^daily at (\d\d:\d\d), keeping (\d+)$/, '매일 $1, $2개 보관');
        if (a.subject === 'trash') summary = summary.replace(/^(\d+) task\(s\)$/, '작업 $1개');
        return tpl.replace('{who}', mine ? '내가' : a.actorName + '님이').replace('{x}', summary).replace('{file}', file);
      }
    }
    var who = mine ? T('You') : a.actorName;
    var what = a.summary ? (' ' + a.subject + ' ' + String.fromCharCode(8220) + a.summary + String.fromCharCode(8221)) : (' the ' + a.subject);
    return who + ' ' + a.verb + what;
  }

  // ---- notifications (assigned to you, mentioned, a comment on your work) ----
  // The bell holds two things: what is for you, and the shared activity feed.
  // Notifications live on the server per account, so read/unread follows you
  // between devices; activity stays a per-browser "seen" mark as before.
  var DESKTOP_ALERTS_KEY = 'directive_desktop_alerts';
  var notifMaxId = 0;

  function loadDesktopAlerts() {
    try {
      return localStorage.getItem(DESKTOP_ALERTS_KEY) === '1'
        && typeof window.Notification === 'function' && window.Notification.permission === 'granted';
    } catch (e) { return false; }
  }

  function loadNotifications() {
    return api('GET', '/api/notifications').then(function (res) {
      var items = (res && res.items) || [];
      // Only something that arrived after the first load is new enough to
      // pop up; the backlog at sign-in is what the badge is for.
      var fresh = notifMaxId ? items.filter(function (n) { return n.id > notifMaxId && !n.read; }) : [];
      state.notifications = items;
      state.notifUnread = (res && res.unread) || 0;
      notifMaxId = Math.max(notifMaxId, items.length ? items[0].id : 0, 1);
      fresh.forEach(showDesktopAlert);
    }).catch(function () {});
  }

  function notificationLine(n) {
    var q = String.fromCharCode(8220) + n.taskTitle + String.fromCharCode(8221);
    var p = { who: n.actorName, task: q };
    if (n.kind === 'assigned') return T('{who} assigned you {task}', p);
    if (n.kind === 'mentioned') return T('{who} mentioned you on {task}', p);
    if (n.kind === 'commented') return T('{who} commented on {task}', p);
    if (n.kind === 'dueToday') return T('{task} is due today', p);
    if (n.kind === 'dueTomorrow') return T('{task} is due tomorrow', p);
    return n.actorName + ' ' + q;
  }

  // A system notification, for when this tab is in the background. The bell
  // badge covers the tab being in front.
  function showDesktopAlert(n) {
    if (!state.desktopAlerts || !document.hidden) return;
    try {
      var alert = new window.Notification(state.appName, { body: notificationLine(n), tag: 'directive-' + n.id });
      alert.onclick = function () { window.focus(); openNotification(n.id); alert.close(); };
    } catch (e) {}
  }

  function toggleDesktopAlerts() {
    if (state.desktopAlerts) {
      try { localStorage.setItem(DESKTOP_ALERTS_KEY, '0'); } catch (e) {}
      setState({ desktopAlerts: false });
      return;
    }
    if (typeof window.Notification !== 'function') {
      window.alert(T('This browser cannot show desktop notifications.'));
      return;
    }
    // Browsers only offer notifications to a page served over HTTPS (or from
    // localhost) - one more reason to put the server behind TLS.
    if (!window.isSecureContext) {
      window.alert(T('Desktop notifications need this page to be opened over HTTPS.'));
      return;
    }
    window.Notification.requestPermission().then(function (perm) {
      var on = perm === 'granted';
      try { localStorage.setItem(DESKTOP_ALERTS_KEY, on ? '1' : '0'); } catch (e) {}
      if (!on) window.alert(T('Notifications are blocked for this site in the browser settings.'));
      setState({ desktopAlerts: on });
    });
  }

  function markNotificationsRead(ids) {
    var body = ids ? { ids: ids } : { all: true };
    state.notifications.forEach(function (n) { if (!ids || ids.indexOf(n.id) !== -1) n.read = true; });
    state.notifUnread = ids ? state.notifications.filter(function (n) { return !n.read; }).length : 0;
    render();
    return api('POST', '/api/notifications/read', body).then(loadNotifications).then(render).catch(function () {});
  }

  function openNotification(id) {
    var n = state.notifications.filter(function (x) { return x.id === id; })[0];
    if (!n) return;
    if (!n.read) markNotificationsRead([id]);
    closeDropdowns();
    if (n.taskGone) { window.alert(T('That task has been deleted.')); return; }
    if (n.taskId) openTaskDetail(n.taskId);
  }

  function setBellTab(tab) {
    setState({ bellTab: tab });
    if (tab === 'activity') markActivitySeen();
  }

  // ---- repeating tasks ----
  // The server stores an RFC 5545 RRULE. The editor offers the common shapes;
  // anything else (made on a phone, say) is shown as a custom rule and kept.
  var REPEAT_OPTIONS = [
    ['none', T('Does not repeat')], ['daily', T('Daily')], ['weekdays', T('Every weekday')],
    ['weekly', T('Weekly')], ['monthly', T('Monthly')], ['yearly', T('Yearly')]
  ];
  var REPEAT_UNITS = { daily: ['day', 'days'], weekly: ['week', 'weeks'], monthly: ['month', 'months'], yearly: ['year', 'years'] };
  var WEEKDAYS_RULE = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';

  function parseRepeat(rule) {
    if (!rule) return { freq: 'none', interval: 1 };
    if (rule.toUpperCase() === WEEKDAYS_RULE) return { freq: 'weekdays', interval: 1 };
    var parts = {};
    rule.split(';').forEach(function (p) {
      var kv = p.split('=');
      if (kv.length === 2) parts[kv[0].toUpperCase()] = kv[1].toUpperCase();
    });
    var simple = Object.keys(parts).every(function (k) { return k === 'FREQ' || k === 'INTERVAL'; });
    var freq = (parts.FREQ || '').toLowerCase();
    if (simple && REPEAT_UNITS[freq]) {
      var n = parseInt(parts.INTERVAL || '1', 10);
      return { freq: freq, interval: n > 0 ? n : 1 };
    }
    return { freq: 'custom', interval: 1 };
  }

  function buildRepeat(freq, interval) {
    if (freq === 'none') return '';
    if (freq === 'weekdays') return WEEKDAYS_RULE;
    var n = Math.max(1, Math.min(999, parseInt(interval, 10) || 1));
    return 'FREQ=' + freq.toUpperCase() + (n > 1 ? ';INTERVAL=' + n : '');
  }

  function describeRepeat(rule) {
    var r = parseRepeat(rule);
    if (r.freq === 'none') return '';
    if (r.freq === 'weekdays') return T('Every weekday');
    if (r.freq === 'custom') return T('Repeats (custom rule)');
    var unit = REPEAT_UNITS[r.freq];
    return r.interval === 1 ? T('Every ' + unit[0]) : T('Every {n} ' + unit[1], { n: r.interval });
  }

  function todayIso() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // A repeat needs a date to count from, so an empty due date is filled
  // with today rather than failing on save.
  function setRepeatFreq(freq) {
    if (freq === 'custom') return;
    var f = Object.assign({}, state.newTaskForm);
    f.recurrence = buildRepeat(freq, parseRepeat(f.recurrence).interval);
    if (f.recurrence && !f.due) f.due = todayIso();
    setState({ newTaskForm: f });
  }

  function setRepeatInterval(value) {
    var f = Object.assign({}, state.newTaskForm);
    var r = parseRepeat(f.recurrence);
    if (!REPEAT_UNITS[r.freq]) return;
    f.recurrence = buildRepeat(r.freq, value);
    setState({ newTaskForm: f });
  }

  // ---- snackbar (undo) ----
  var snackToken = 0;
  var SNACK_MS = 7000;

  function showSnackbar(text, action, data) {
    var id = ++snackToken;
    setState({ snackbar: { id: id, text: text, action: action || '', data: data } });
    setTimeout(function () { if (state.snackbar && state.snackbar.id === id) dismissSnackbar(); }, SNACK_MS);
  }

  function dismissSnackbar() {
    if (!state.snackbar || state.snackbar.closing) return;
    var id = state.snackbar.id;
    setState({ snackbar: Object.assign({}, state.snackbar, { closing: true }) });
    setTimeout(function () { if (state.snackbar && state.snackbar.id === id) setState({ snackbar: null }); }, 220);
  }

  function snackbarAction() {
    var sb = state.snackbar;
    if (!sb) return;
    if (sb.action === 'undoDelete') {
      dismissSnackbar();
      api('POST', '/api/trash/' + sb.data + '/restore').then(refreshTasks).catch(function (e) { window.alert(e.message); });
    }
  }

  // ---- trash ----
  function loadTrash() {
    return api('GET', '/api/trash').then(function (list) { state.trash = list || []; }).catch(function () { state.trash = []; });
  }

  function openTrash() {
    focusDialogOnNextRender();
    closeMobileNav();
    setState({ trashModalPhase: 'open' });
    loadTrash().then(render);
  }

  function closeTrash() {
    if (state.trashModalPhase !== 'open') return;
    setState({ trashModalPhase: 'closing' });
    setTimeout(function () { if (state.trashModalPhase === 'closing') setState({ trashModalPhase: 'closed' }); }, MODAL_CLOSE_MS);
  }

  function restoreTrashed(id) {
    playOnce('trashLeave:' + id, 'anim-item-out', 360);
    render();
    api('POST', '/api/trash/' + id + '/restore').then(function () {
      return Promise.all([loadTrash(), fetchTasks(), fetchSummary(), fetchToday()]);
    }).then(render).catch(function (e) { window.alert(e.message); loadTrash().then(render); });
  }

  function purgeTrashed(id) {
    var t = state.trash.filter(function (x) { return x.id === id; })[0];
    if (!window.confirm(T('Delete {task} for good? This cannot be undone.', { task: t ? '"' + t.title + '"' : T('this task') }))) return;
    api('DELETE', '/api/trash/' + id).then(function () {
      return Promise.all([loadTrash(), fetchSummary()]);
    }).then(render).catch(function (e) { window.alert(e.message); });
  }

  function emptyTrash() {
    var n = state.trash.filter(function (t) { return t.canRestore; }).length;
    if (!n || !window.confirm(T(n === 1 ? 'Delete {n} task in the trash for good? This cannot be undone.' : 'Delete {n} tasks in the trash for good? This cannot be undone.', { n: n }))) return;
    api('DELETE', '/api/trash').then(function () {
      return Promise.all([loadTrash(), fetchSummary()]);
    }).then(render).catch(function (e) { window.alert(e.message); });
  }

  function daysLeft(purgeAt) {
    var ms = new Date(purgeAt).getTime() - Date.now();
    if (isNaN(ms)) return '';
    var days = Math.ceil(ms / 86400000);
    return days <= 1 ? T('Removed within a day') : T('{n} days left', { n: days });
  }

  // ---- app passwords (phone sync) ----
  function loadAppPasswords() {
    return api('GET', '/api/me/app-passwords').then(function (list) { state.appPasswords = list || []; }).catch(function () { state.appPasswords = []; });
  }

  function openAppPasswords() {
    focusDialogOnNextRender();
    setState({ appPwModalPhase: 'open', accountOpen: false, dropdownClosing: '', appPwName: '', appPwCreated: null });
    loadAppPasswords().then(render);
  }

  function closeAppPasswords() {
    if (state.appPwModalPhase !== 'open') return;
    setState({ appPwModalPhase: 'closing' });
    // The new password is shown once; closing the dialog forgets it.
    setTimeout(function () { if (state.appPwModalPhase === 'closing') setState({ appPwModalPhase: 'closed', appPwCreated: null }); }, MODAL_CLOSE_MS);
  }

  function createAppPassword() {
    var name = (state.appPwName || '').trim();
    if (!name) { window.alert(T('Name the device first, e.g. "iPhone".')); return; }
    api('POST', '/api/me/app-passwords', { name: name }).then(function (created) {
      state.appPwName = '';
      state.appPwCreated = created;
      playOnce('appPwNew', 'anim-item-in', 390);
      return loadAppPasswords();
    }).then(render).catch(function (e) { window.alert(e.message); });
  }

  function revokeAppPassword(id) {
    var p = state.appPasswords.filter(function (x) { return x.id === id; })[0];
    if (!window.confirm(T('Revoke {name}? The device using it stops syncing straight away.', { name: p ? '"' + p.name + '"' : T('this app password') }))) return;
    api('DELETE', '/api/me/app-passwords/' + id).then(function () {
      if (state.appPwCreated && state.appPwCreated.id === id) state.appPwCreated = null;
      return loadAppPasswords();
    }).then(render).catch(function (e) { window.alert(e.message); });
  }

  function copyText(text, token) {
    var done = function () { showCopied(token); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { window.prompt(T('Copy this:'), text); });
    } else {
      window.prompt(T('Copy this:'), text);
    }
  }

  // ---- automatic backups (administrator) ----
  function loadBackups() {
    return api('GET', '/api/backups').then(function (b) {
      state.backups = b;
      if (b) state.backupForm = { enabled: !!b.enabled, time: b.time, keep: b.keep };
    }).catch(function () {});
  }

  function openBackups() {
    focusDialogOnNextRender();
    setState({ backupModalPhase: 'open', accountOpen: false, dropdownClosing: '' });
    loadBackups().then(render);
  }

  function closeBackups() {
    if (state.backupModalPhase !== 'open') return;
    setState({ backupModalPhase: 'closing' });
    setTimeout(function () { if (state.backupModalPhase === 'closing') setState({ backupModalPhase: 'closed' }); }, MODAL_CLOSE_MS);
  }

  function saveBackupSettings() {
    var f = state.backupForm;
    api('PUT', '/api/backups', { enabled: !!f.enabled, time: f.time, keep: Number(f.keep) }).then(function (b) {
      state.backups = b;
      state.backupForm = { enabled: !!b.enabled, time: b.time, keep: b.keep };
      showSnackbar(b.enabled ? T('Automatic backups on, daily at {time}', { time: b.time }) : T('Automatic backups off'));
    }).catch(function (e) { window.alert(e.message); });
  }

  // ---- due-date reminders (administrator) ----
  function loadReminders() {
    return api('GET', '/api/reminders').then(function (r) {
      state.reminders = r;
      if (r) state.reminderForm = { enabled: !!r.enabled, time: r.time };
    }).catch(function () {});
  }

  function openReminders() {
    closeDropdowns();
    setState({ reminderModalPhase: 'open', accountOpen: false, dropdownClosing: '' });
    loadReminders().then(render);
  }

  function closeReminders() {
    if (state.reminderModalPhase !== 'open') return;
    setState({ reminderModalPhase: 'closing' });
    setTimeout(function () { if (state.reminderModalPhase === 'closing') setState({ reminderModalPhase: 'closed' }); }, MODAL_CLOSE_MS);
  }

  function saveReminderSettings() {
    var f = state.reminderForm;
    api('PUT', '/api/reminders', { enabled: !!f.enabled, time: f.time }).then(function (r) {
      state.reminders = r;
      state.reminderForm = { enabled: !!r.enabled, time: r.time };
      closeReminders();
      showSnackbar(r.enabled ? T('Due-date reminders on, daily at {time}', { time: r.time }) : T('Due-date reminders off'));
    }).catch(function (e) { window.alert(e.message); });
  }

  function runBackup() {
    if (state.backupBusy) return;
    setState({ backupBusy: true });
    api('POST', '/api/backups/run').then(function (b) {
      state.backups = b;
      state.backupBusy = false;
      showSnackbar(T('Backup written: {file}', { file: b.lastFile }));
    }).catch(function (e) { setState({ backupBusy: false }); window.alert(e.message); });
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ---- checklists ----
  function loadChecklist(taskId) {
    return api('GET', '/api/tasks/' + taskId + '/checklist').then(function (list) {
      state.checklist = list || [];
    }).catch(function () { state.checklist = []; });
  }

  // The new-task form keeps its items locally until the task exists; an open
  // task sends each change straight away.
  function addChecklistItem() {
    var body = (state.checklistDraft || '').trim();
    if (!body) return;
    state.checklistDraft = '';
    if (isNewTaskForm()) {
      var f = Object.assign({}, state.newTaskForm);
      f.checklistItems = (f.checklistItems || []).concat([body]);
      setState({ newTaskForm: f });
      focusLater('checklistDraftInput');
      return;
    }
    var taskId = currentTaskId();
    api('POST', '/api/tasks/' + taskId + '/checklist', { body: body }).then(function (item) {
      if (item) playOnce('check:' + item.id, 'anim-item-in', 390);
      return loadChecklist(taskId);
    }).then(function () {
      render();
      focusLater('checklistDraftInput');
      return refreshTasks();
    }).catch(function (e) { window.alert(e.message); });
  }

  function toggleChecklistItem(id) {
    var item = state.checklist.filter(function (x) { return x.id === id; })[0];
    if (!item) return;
    item.done = !item.done;
    render();
    api('PUT', '/api/checklist/' + id, { done: item.done }).then(refreshTasks).catch(function (e) {
      item.done = !item.done;
      render();
      window.alert(e.message);
    });
  }

  // For the new-task form, id is the item's index in the local list.
  function deleteChecklistItem(id) {
    if (isNewTaskForm()) {
      var f = Object.assign({}, state.newTaskForm);
      f.checklistItems = (f.checklistItems || []).filter(function (_, i) { return i !== id; });
      setState({ newTaskForm: f });
      return;
    }
    var taskId = currentTaskId();
    state.checklist = state.checklist.filter(function (x) { return x.id !== id; });
    render();
    api('DELETE', '/api/checklist/' + id).then(function () { return loadChecklist(taskId); })
      .then(refreshTasks).catch(function (e) { window.alert(e.message); loadChecklist(taskId).then(render); });
  }

  function moveChecklistItem(id, delta) {
    var list = state.checklist.slice();
    var i = list.map(function (x) { return x.id; }).indexOf(id);
    var j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    state.checklist = list;
    render();
    api('PUT', '/api/tasks/' + currentTaskId() + '/checklist/order', { ids: list.map(function (x) { return x.id; }) })
      .catch(function (e) { window.alert(e.message); });
  }

  function focusLater(id, caret) {
    setTimeout(function () {
      var el = document.getElementById(id);
      if (!el) return;
      el.focus();
      if (caret != null && el.setSelectionRange) { try { el.setSelectionRange(caret, caret); } catch (e) {} }
    }, 0);
  }

  // ---- @mentions in comments ----
  var MENTION_RE = /(^|\s)@([^\s@]{0,30})$/;

  function mentionCandidates(query) {
    var q = (query || '').toLowerCase();
    return state.members.filter(function (m) {
      if (state.user && m.id === state.user.id) return false;
      var name = m.displayName.toLowerCase();
      return !q || name.split(/\s+/).some(function (w) { return w.indexOf(q) === 0; });
    }).slice(0, 6);
  }

  // Looks at what is typed just before the caret. Only re-renders when the
  // picker opens, closes or its query changes - ordinary typing in the
  // comment box stays a silent update.
  function updateMention(el) {
    var before = el.value.slice(0, el.selectionStart || 0);
    var m = MENTION_RE.exec(before);
    var next = m ? { query: m[2], at: before.length - m[2].length - 1, index: 0 } : null;
    if (next && !mentionCandidates(next.query).length) next = null;
    var cur = state.mention;
    if (!next && !cur) return;
    if (next && cur && cur.query === next.query && cur.at === next.at) return;
    state.mention = next;
    render();
  }

  function moveMention(delta) {
    var list = mentionCandidates(state.mention.query);
    state.mention.index = (state.mention.index + delta + list.length) % list.length;
    render();
  }

  function pickMention(memberId) {
    var m = state.mention;
    var member = memberById(memberId);
    if (!m || !member) return;
    var text = state.commentDraft || '';
    var insert = '@' + member.displayName + ' ';
    state.commentDraft = text.slice(0, m.at) + insert + text.slice(m.at + 1 + m.query.length);
    state.mention = null;
    render();
    focusLater('commentDraftInput', m.at + insert.length);
  }

  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // A known name after "@" is shown as a mention, longest names first so
  // "@Ada Lovelace" is not cut short at "@Ada".
  function renderCommentBody(body, c) {
    var html = esc(body);
    state.members.map(function (m) { return m.displayName; })
      .sort(function (a, b) { return b.length - a.length; })
      .forEach(function (n) {
        var re = new RegExp('(^|[\\s(])(' + escapeRegExp(esc('@' + n)) + ')(?![\\w])', 'gi');
        html = html.replace(re, function (_, lead, hit) {
          return lead + '<span class="mention" style="color:' + c.onPrimaryContainer + '; background:' + c.primaryContainer + ';">' + hit + '</span>';
        });
      });
    return html;
  }

  // ---- task detail view ----
  // Clicking a task opens it to read: its body, checklist, files and
  // discussion in one place. Editing its fields is a step further, behind the
  // gear, and comes back here when it is done.
  var detailToken = 0;

  // The task whose checklist and comments are on screen - the detail view's,
  // or the editor's when that was opened some other way.
  function currentTaskId() { return state.detailTaskId || state.editingTaskId; }
  function isNewTaskForm() { return state.newTaskModalPhase === 'open' && !state.editingTaskId; }

  function detailTask() {
    return state.detailTask && state.detailTask.id === state.detailTaskId ? state.detailTask : findLoadedTask(state.detailTaskId);
  }

  // The detail always reads the task fresh, so it shows what the server has
  // rather than whichever copy a list happened to load.
  function loadDetailTask(id) {
    return api('GET', '/api/tasks/' + id).then(function (t) {
      if (state.detailTaskId === id) state.detailTask = t;
      state.extraTasks[id] = t;
    }).catch(function (e) {
      if (state.detailTaskId === id && e.status === 404) {
        closeTaskDetail();
        showSnackbar(T('That task was deleted.'));
      }
    });
  }

  function loadAttachments(taskId) {
    return api('GET', '/api/tasks/' + taskId + '/attachments').then(function (list) {
      if (currentTaskId() === taskId) state.attachments = list || [];
    }).catch(function () { state.attachments = []; });
  }

  function openTaskDetail(id) {
    focusDialogOnNextRender();
    var token = ++detailToken;
    state.comments = [];
    state.commentDraft = '';
    state.mention = null;
    state.checklist = [];
    state.checklistDraft = '';
    state.attachments = [];
    state.iconPickerOpen = false;
    state.iconPickerClosing = false;
    setState({ detailTaskId: id, detailTask: findLoadedTask(id), detailPhase: 'open', notifOpen: false });
    Promise.all([loadDetailTask(id), loadComments(id), loadChecklist(id), loadAttachments(id)]).then(function () {
      if (detailToken === token) render();
    });
  }

  function closeTaskDetail() {
    if (state.detailPhase !== 'open') return;
    var token = ++detailToken;
    setState({ detailPhase: 'closing', iconPickerOpen: false, iconPickerClosing: false, mention: null });
    setTimeout(function () {
      if (detailToken === token) setState({ detailPhase: 'closed', detailTaskId: null, detailTask: null, attachments: [] });
    }, MODAL_CLOSE_MS);
  }

  // The gear opens the editor on top of the detail, which stays open
  // underneath - closing the editor simply uncovers it again, already
  // showing the saved changes.
  function editFromDetail() {
    var id = state.detailTaskId;
    if (!id) return;
    state.iconPickerOpen = false;
    state.iconPickerClosing = false;
    openEditTask(id);
  }

  // The status can be changed straight from the detail, without the editor.
  function setDetailStatus(status) {
    var t = detailTask();
    if (!t || t.status === status) return;
    var id = t.id;
    api('PUT', '/api/tasks/' + id + '/status', { status: status }).then(function (res) {
      if (res && res.nextId) showSnackbar(T('Done. The next one is scheduled.'));
      return Promise.all([loadDetailTask(id), refreshTasks()]);
    }).then(render).catch(function (e) { window.alert(e.message); });
  }

  // ---- attachments ----
  var MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

  function pickAttachments() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', function () {
      var files = Array.prototype.slice.call(inp.files || []);
      document.body.removeChild(inp);
      uploadAttachments(files);
    });
    inp.click();
  }

  // One at a time, so a list of files arrives in the order it was chosen and
  // a failure names the file it was about.
  function uploadAttachments(files) {
    var taskId = state.detailTaskId;
    if (!taskId || !files.length) return;
    var tooBig = files.filter(function (f) { return f.size > MAX_ATTACHMENT_BYTES; });
    if (tooBig.length) window.alert(T('{files}: a file can be at most 20 MB.', { files: tooBig.map(function (f) { return f.name; }).join(', ') }));
    files = files.filter(function (f) { return f.size <= MAX_ATTACHMENT_BYTES && f.size > 0; });
    if (!files.length) return;
    setState({ uploading: state.uploading + files.length });
    files.reduce(function (chain, f) {
      return chain.then(function () {
        return fetch('/api/tasks/' + taskId + '/attachments', {
          method: 'POST', credentials: 'same-origin', body: f,
          headers: { 'X-Client-Id': CLIENT_ID, 'Content-Type': f.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name || 'file') }
        }).then(function (res) {
          if (!res.ok) return res.json().catch(function () { return {}; }).then(function (d) {
            // A 413 without our JSON is a reverse proxy's own size limit, set below ours.
            if (res.status === 413 && !d.error) throw new Error(T('{file}: the web server in front of Directive refused a file this large. Its upload limit needs raising (see the README).', { file: f.name }));
            throw new Error(f.name + ': ' + (d.error ? TE(d.error) : T('upload failed')));
          });
          return res.json();
        }).then(function (a) {
          if (a && a.id) playOnce('att:' + a.id, 'anim-item-in', 390);
        }).catch(function (e) { window.alert(e.message); }).then(function () {
          state.uploading = Math.max(0, state.uploading - 1);
          return loadAttachments(taskId).then(render);
        });
      });
    }, Promise.resolve()).then(function () { return Promise.all([loadDetailTask(taskId), refreshTasks()]); }).then(render);
  }

  function deleteAttachment(id) {
    var a = state.attachments.filter(function (x) { return x.id === id; })[0];
    if (!window.confirm(T('Remove {name} from the task?', { name: a ? '"' + a.name + '"' : T('this file') }))) return;
    var taskId = state.detailTaskId;
    api('DELETE', '/api/attachments/' + id).then(function () {
      return Promise.all([loadAttachments(taskId), loadDetailTask(taskId), refreshTasks()]);
    }).then(render).catch(function (e) { window.alert(e.message); });
  }

  function openLightbox(id) {
    var a = state.attachments.filter(function (x) { return x.id === id; })[0];
    if (a) setState({ lightbox: a });
  }
  function closeLightbox() { if (state.lightbox) setState({ lightbox: null }); }

  // ---- task icons ----
  // Grouped like a phone's emoji keyboard. The tabs along the top jump to a
  // group; data-id is the emoji's place in the flat list, so a pick survives
  // any regrouping.
  var TASK_EMOJI_GROUPS = [
    ['Work', '📌 📍 ✅ ☑️ ✔️ ❌ ⭕ 📝 ✏️ 🖊️ 📋 📅 📆 🗓️ ⏰ ⏱️ ⌛ ⏳ 🔔 📣 📢 💡 🔥 ⭐ 🌟 ✨ 🚀 🎯 🏁 🚩 🏆 🥇 🎖️ ⚠️ ❗ ❓ 🆕 🔄 🔁 ♻️ 🗑️'],
    ['Office', '💼 📁 📂 🗂️ 📄 📃 📑 🧾 📊 📈 📉 🗃️ 🗄️ 📎 🖇️ 📐 📏 ✂️ 🖨️ 💻 🖥️ ⌨️ 🖱️ 📱 ☎️ 📞 📠 ✉️ 📧 📨 📬 📦 🏷️ 🔖 📚 📖 📰 🗞️'],
    ['Tech', '🐛 🔧 🔨 🛠️ ⚙️ 🔩 🧰 🧪 🔬 🔭 🧬 🤖 💾 💿 🔌 🔋 📡 🛰️ 🌐 🔒 🔓 🔑 🗝️ 🛡️ 🧯 🚨 🧱 🏗️ 🧩 🖲️'],
    ['People', '👤 👥 🧑‍💻 👩‍💼 👨‍🔧 🧑‍🏫 🧑‍⚕️ 🤝 👋 👍 👎 👏 🙌 💪 🙏 👀 🧠 💬 🗨️ 💭 🗣️ 😀 😊 😎 🤔 😅 😴 🥳 😡 😭'],
    ['Places', '💰 💵 💳 🪙 🏦 🧮 💹 🛒 🛍️ 🎁 🧧 🚚 🚛 ✈️ 🚢 🚗 🚌 🚲 🏠 🏢 🏬 🏭 🏥 🏫 🏪 🗺️ 🧭 📮'],
    ['Life', '☕ 🍵 🍽️ 🍕 🍔 🍱 🍎 🥗 🍰 🎂 🍷 🍺 💊 🩺 🏃 🧘 🏋️ ⚽ 🏀 🎾 🎮 🎧 🎵 🎬 🎨 📷 🎥 🧹 🧺 🧼 🪴 🐶 🐱'],
    ['Nature', '☀️ 🌤️ ⛅ 🌧️ ⛈️ ❄️ 🌈 🌙 🌊 💧 🌍 🌏 🏔️ 🏖️ 🌋 🌱 🌿 🌳 🌸 🌻 🍂 🍁'],
    ['Symbols', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🔺 🔻 🔷 🔶 ➕ ➖ 💯 #️⃣ 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 🅰️ 🅱️ 🆘 ⛔ 🚫']
  ].map(function (g) { return [g[0], g[1].split(' ')]; });
  var TASK_EMOJIS = [];
  TASK_EMOJI_GROUPS.forEach(function (g) {
    // An emoji listed twice keeps its first place, so each appears once.
    g[1] = g[1].filter(function (e) { return TASK_EMOJIS.indexOf(e) === -1; });
    TASK_EMOJIS = TASK_EMOJIS.concat(g[1]);
  });

  // Scrolls the picker's grid to a group, inside the grid only - the dialog
  // behind it stays where it is.
  function jumpToEmojiGroup(i) {
    var grid = document.querySelector('.emoji-grid');
    var head = document.getElementById('emoji-group-' + i);
    if (grid && head) grid.scrollTop = head.offsetTop - grid.offsetTop;
  }

  // The picker animates like the other dropdowns. It stays mounted for its
  // exit, and the motion keys are cleared once it is gone so the next open
  // plays its entrance again instead of resuming a finished one.
  var ICON_PICKER_OUT_MS = 225;
  var iconPickerToken = 0;

  function openIconPicker() {
    ++iconPickerToken;
    motion('icon:in', false);
    motion('icon:out', false);
    setState({ iconPickerOpen: true, iconPickerClosing: false });
  }

  function closeIconPicker() {
    if (!state.iconPickerOpen) return;
    var token = ++iconPickerToken;
    setState({ iconPickerOpen: false, iconPickerClosing: true });
    setTimeout(function () {
      if (iconPickerToken !== token) return;
      motion('icon:in', false);
      motion('icon:out', false);
      setState({ iconPickerClosing: false });
    }, ICON_PICKER_OUT_MS);
  }

  function toggleIconPicker() { if (state.iconPickerOpen) closeIconPicker(); else openIconPicker(); }

  function setTaskIcon(body) {
    var id = state.detailTaskId;
    api('PUT', '/api/tasks/' + id + '/icon', body).then(function () {
      closeIconPicker();
      return Promise.all([loadDetailTask(id), refreshTasks()]);
    }).then(render).catch(function (e) { window.alert(e.message); });
  }

  function pickTaskEmoji(i) { var e = TASK_EMOJIS[i]; if (e) setTaskIcon({ emoji: e }); }
  function uploadTaskIcon() { pickImage(function (img) { setTaskIcon(img); }); }

  function removeTaskIcon() {
    var id = state.detailTaskId;
    api('DELETE', '/api/tasks/' + id + '/icon').then(function () {
      closeIconPicker();
      return Promise.all([loadDetailTask(id), refreshTasks()]);
    }).then(render).catch(function (e) { window.alert(e.message); });
  }

  // The icon beside a title: an emoji, the uploaded picture, or nothing.
  function taskIconHtml(t, sizePx) {
    if (!t || !t.icon) return '';
    if (t.icon === 'image') {
      return '<img class="task-icon" src="/api/tasks/' + t.id + '/icon?v=' + encodeURIComponent(t.updatedAt || '') + '" alt="" style="width:' + sizePx + 'px; height:' + sizePx + 'px; border-radius:' + Math.round(sizePx * 0.22) + 'px; object-fit:cover; flex-shrink:0; vertical-align:middle;">';
    }
    // A fixed square with the glyph centred in it: an emoji's own box sits
    // on the text baseline and would otherwise ride high beside the title.
    return '<span class="task-icon" aria-hidden="true" style="display:inline-flex; align-items:center; justify-content:center; width:' + sizePx + 'px; height:' + sizePx + 'px; font-size:' + Math.round(sizePx * 0.84) + 'px; line-height:1; flex-shrink:0;">' + esc(t.icon) + '</span>';
  }

  // ---- passwords ----
  function openPasswordModal() {
    focusDialogOnNextRender();
    setState({ passwordModalPhase: 'open', accountOpen: false, dropdownClosing: '', pwForm: { current: '', next: '', confirm: '' }, pwError: '' });
  }

  function closePasswordModal() {
    if (state.passwordModalPhase !== 'open') return;
    setState({ passwordModalPhase: 'closing' });
    setTimeout(function () { if (state.passwordModalPhase === 'closing') setState({ passwordModalPhase: 'closed', pwForm: { current: '', next: '', confirm: '' } }); }, MODAL_CLOSE_MS);
  }

  function submitPasswordChange() {
    var f = state.pwForm;
    if (!f.current || !f.next) { setState({ pwError: T('Fill in both passwords.') }); return; }
    if (f.next.length < 8) { setState({ pwError: T('The new password needs at least 8 characters.') }); return; }
    if (f.next !== f.confirm) { setState({ pwError: T('The two new passwords do not match.') }); return; }
    var forced = !!(state.user && state.user.mustChangePassword);
    api('PUT', '/api/me/password', { current: f.current, new: f.next }).then(function () {
      state.pwForm = { current: '', next: '', confirm: '' };
      state.pwError = '';
      if (forced) {
        state.user.mustChangePassword = false;
        return loadAll().then(function () { render(); showSnackbar(T('Password set. Welcome back.')); });
      }
      closePasswordModal();
      showSnackbar(T('Password changed. Your other sign-ins were signed out.'));
    }).catch(function (e) { setState({ pwError: e.message }); });
  }

  function resetUserPassword(id) {
    var u = state.users.filter(function (x) { return x.id === id; })[0];
    if (!u || !window.confirm(T('Reset the password for {name}? They are signed out everywhere and get a temporary password that you hand them; the app then asks them to choose their own.', { name: u.displayName }))) return;
    api('POST', '/api/users/' + id + '/reset-password').then(function (res) {
      state.resetResult = { id: id, name: u.displayName, temp: res.temporaryPassword };
      playOnce('resetResult', 'anim-item-in', 390);
      return loadUsers();
    }).then(render).catch(function (e) { window.alert(e.message); });
  }

  // ---- Material menus in place of native selects ----
  // A native <select> opens the operating system's own list, which ignores
  // the app's colours and shape. mSelectFrom takes the same <select> markup
  // the views already build and draws a Material 3 menu instead: a field
  // that shows the choice, and a list that opens under it. Picking an item
  // goes through the same change handling a real select would, so every
  // form keeps working exactly as before.
  var mselects = {};
  var MSELECT_OUT_MS = 150;
  var mselectToken = 0;

  function unescHtml(s) {
    return String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  function mSelectFrom(html, c, variant) {
    var head = /^<select([^>]*)>/.exec(html);
    var attrs = {};
    var attrRe = /([\w-]+)(?:="([^"]*)")?/g, am;
    while ((am = attrRe.exec(head ? head[1] : ''))) attrs[am[1]] = am[2] === undefined ? '' : unescHtml(am[2]);
    var options = [], om, optRe = /<option value="([^"]*)"( selected)?>([\s\S]*?)<\/option>/g;
    var value = null;
    while ((om = optRe.exec(html))) {
      options.push({ value: unescHtml(om[1]), label: om[3] });
      if (om[2] && value === null) value = unescHtml(om[1]);
    }
    if (value === null && options.length) value = options[0].value;
    var id = attrs.id || ('ms-' + Object.keys(attrs).filter(function (k) { return k.indexOf('data-') === 0; })
      .map(function (k) { return k + '-' + attrs[k]; }).join('-').replace(/[^\w-]/g, '_'));
    var disabled = attrs.hasOwnProperty('disabled');
    mselects[id] = { attrs: attrs, options: options, value: value };
    var current = options.filter(function (o) { return o.value === value; })[0];
    var open = state.openSelect === id;
    var chevron = '<svg class="mselect-chevron" width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8l4 4 4-4"></path></svg>';
    return '<div id="' + esc(id) + '" class="' + (disabled ? '' : 'interactive ') + 'mselect-trigger mselect-' + (variant || 'field') + (open ? ' open' : '') + '"'
      + (disabled ? ' aria-disabled="true"' : ' data-action="toggleMSelect" data-id="' + esc(id) + '"')
      + ' role="combobox" aria-haspopup="listbox" aria-expanded="' + (open ? 'true' : 'false') + '"'
      + (attrs['aria-label'] ? ' aria-label="' + esc(attrs['aria-label']) + '"' : '')
      + ' style="' + esc(attrs.style || '') + (open ? 'border-color:' + c.primary + '; box-shadow:0 0 0 1px ' + c.primary + ';' : '') + '">'
      + '<span class="mselect-label">' + (current ? current.label : '') + '</span>' + chevron + '</div>';
  }

  function openMSelect(id) {
    var ms = mselects[id];
    if (!ms) return;
    ++mselectToken;
    motion('mselect:in', false);
    motion('mselect:out', false);
    var idx = ms.options.map(function (o) { return o.value; }).indexOf(ms.value);
    setState({ openSelect: id, selectClosing: '', selectIndex: idx < 0 ? 0 : idx });
  }

  function closeMSelect() {
    var id = state.openSelect;
    if (!id) return;
    var token = ++mselectToken;
    setState({ openSelect: '', selectClosing: id });
    setTimeout(function () {
      if (mselectToken !== token) return;
      motion('mselect:in', false);
      motion('mselect:out', false);
      setState({ selectClosing: '' });
    }, MSELECT_OUT_MS);
  }

  function toggleMSelect(id) { if (state.openSelect === id) closeMSelect(); else openMSelect(id); }

  // Hands the choice to the change handling as if the native select had
  // fired - same id, same data-form and data-field, same value.
  function pickMSelect(id, value) {
    var ms = mselects[id];
    closeMSelect();
    if (!ms || value === ms.value) return;
    onControlChange({
      id: ms.attrs.id || '', value: value, tagName: 'SELECT', checked: false,
      getAttribute: function (k) { return ms.attrs.hasOwnProperty(k) ? ms.attrs[k] : null; }
    });
  }

  function moveMSelect(delta) {
    var ms = mselects[state.openSelect];
    if (!ms || !ms.options.length) return;
    setState({ selectIndex: (state.selectIndex + delta + ms.options.length) % ms.options.length });
  }

  // The list is drawn at the top of the page, not inside the dialog that
  // holds its field, so a dialog's scrolling edge can never cut it off. It is
  // placed against the field after each render, and opens upward when there
  // is more room above.
  function mSelectMenu(c) {
    var id = state.openSelect || state.selectClosing;
    var ms = id && mselects[id];
    if (!ms) return '';
    var closing = !state.openSelect;
    var enter = motion('mselect:in', !closing, 'mselect-in', 200);
    var exit = motion('mselect:out', closing, 'mselect-out', MSELECT_OUT_MS, true);
    var m = closing ? exit : enter;
    var check = '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5L15.5 6.5"></path></svg>';
    var items = ms.options.map(function (o, i) {
      var selected = o.value === ms.value;
      var active = !closing && i === state.selectIndex;
      return '<div class="interactive mselect-item' + (selected ? ' selected' : '') + (active ? ' active' : '') + '" role="option" aria-selected="' + (selected ? 'true' : 'false') + '"'
        + ' data-action="pickMSelect" data-id="' + esc(id) + '" data-value="' + esc(o.value) + '"'
        + ' style="' + (selected ? 'background:' + c.primaryContainer + '; color:' + c.onPrimaryContainer + ';' : 'color:' + c.onSurface + ';') + '">'
        + '<span class="mselect-check">' + (selected ? check : '') + '</span>'
        + '<span class="mselect-item-label">' + o.label + '</span></div>';
    }).join('');
    return '<div class="mselect-menu ' + m.cls + '" role="listbox" data-for="' + esc(id) + '" style="' + m.style + 'background:' + c.surface + '; --item-hover:' + c.surfaceContainer + ';">' + items + '</div>';
  }

  function placeMSelectMenu(root) {
    var menu = root.querySelector('.mselect-menu');
    if (!menu) return;
    var trigger = document.getElementById(menu.getAttribute('data-for'));
    if (!trigger) { state.openSelect = ''; state.selectClosing = ''; menu.remove(); return; }
    var r = trigger.getBoundingClientRect();
    var gap = 4, margin = 8;
    var below = window.innerHeight - r.bottom - margin, above = r.top - margin;
    var natural = Math.min(menu.scrollHeight, 320);
    var up = natural > below && above > below;
    menu.style.minWidth = Math.max(r.width, 160) + 'px';
    menu.style.maxHeight = Math.max(120, Math.min(320, (up ? above : below) - gap)) + 'px';
    var left = Math.min(r.left, window.innerWidth - menu.offsetWidth - margin);
    menu.style.left = Math.max(margin, left) + 'px';
    if (up) { menu.style.top = ''; menu.style.bottom = (window.innerHeight - r.top + gap) + 'px'; menu.classList.add('up'); }
    else { menu.style.bottom = ''; menu.style.top = (r.bottom + gap) + 'px'; }
    var active = menu.querySelector('.mselect-item.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  // ---- a symmetric cog ----
  // Drawn from angles rather than by hand, so all eight teeth match.
  var GEAR_PATH = (function () {
    var cx = 12, cy = 12, outer = 9.6, inner = 7.2, teeth = 8, pts = [];
    function pt(deg, rad) {
      var a = (deg - 90) * Math.PI / 180;
      return (cx + rad * Math.cos(a)).toFixed(2) + ' ' + (cy + rad * Math.sin(a)).toFixed(2);
    }
    for (var i = 0; i < teeth; i++) {
      var a = i * 360 / teeth;
      pts.push(pt(a - 13, inner), pt(a - 8, outer), pt(a + 8, outer), pt(a + 13, inner));
    }
    return 'M' + pts.join(' L') + ' Z';
  })();

  // ---- department tree helpers ----

  function findDept(id) { return state.departments.filter(function (d) { return d.id === id; })[0] || null; }


  // Mirrors the server's canWriteDept: an administrator may change anything, a
  // member may change their own department and whatever is nested under it.
  // The server enforces this either way - this only stops the UI offering
  // buttons that would come back 403.
  function canWriteDept(deptId) {
    var u = state.user;
    if (!u) return false;
    if (u.role === 'admin') return true;
    if (!u.deptId || !deptId) return false;
    return deptId === u.deptId || deptId.indexOf(u.deptId + '/') === 0;
  }
  function isAdmin() { return !!state.user && state.user.role === 'admin'; }
  function canCreateTask() { return isAdmin() || !!(state.user && state.user.deptId); }

  function nodeLabel(id) {
    if (!id) return '';
    if (id === 'all') return T('All Tasks');
    if (id === 'mine') return T('My Tasks');
    var d = findDept(id);
    if (!d) return id;
    if (!d.parentId) return d.name;
    var p = findDept(d.parentId);
    return (p ? p.name : d.parentId) + ' · ' + d.name;
  }

  function buildDeptTree() {
    var byId = {};
    state.departments.forEach(function (d) { byId[d.id] = Object.assign({}, d, { children: [] }); });
    var roots = [];
    state.departments.forEach(function (d) {
      if (d.parentId && byId[d.parentId]) byId[d.parentId].children.push(byId[d.id]);
      else if (!d.parentId) roots.push(byId[d.id]);
    });
    return roots;
  }

  function flattenDeptOptions() {
    var out = [];
    buildDeptTree().forEach(function (d) {
      out.push({ id: d.id, label: d.name });
      d.children.forEach(function (ch) { out.push({ id: ch.id, label: d.name + ' · ' + ch.name }); });
    });
    return out;
  }

  function formatDue(iso) {
    if (!iso) return T('No due date');
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return iso;
    return shortDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }

  // The sort order is this viewer's habit, so it is kept per browser; the
  // filters are for the moment and start fresh.
  var TASK_SORT_KEY = 'directive_task_sort';
  var TASK_SORTS = [['created', 'Oldest first'], ['due', 'Due date'], ['priority', 'Priority'], ['updated', 'Recently updated'], ['title', 'Title']];
  function loadTaskSort() {
    try {
      var v = localStorage.getItem(TASK_SORT_KEY);
      // A literal, not TASK_SORTS: this runs while the initial state is built,
      // before that list is assigned.
      return /^(due|priority|updated|title)$/.test(v || '') ? v : 'created';
    } catch (e) { return 'created'; }
  }

  function filtersActive() {
    return state.filterAssignee !== '' || state.filterCalendar !== 'all'
      || !(state.filterPriority.High && state.filterPriority.Medium && state.filterPriority.Low);
  }

  // Filtering, searching and paging happen in SQL now, so state.tasks holds
  // one page and the counts come back with it.
  function taskQueryParams() {
    var params = [];
    params.push('scope=' + encodeURIComponent(state.selectedNode));
    if (state.searchQuery.trim()) params.push('q=' + encodeURIComponent(state.searchQuery.trim()));
    if (state.activeTab !== 'all') params.push('status=' + encodeURIComponent(state.activeTab));
    var priorities = ['High', 'Medium', 'Low'].filter(function (p) { return state.filterPriority[p]; });
    if (priorities.length < 3) params.push('priority=' + encodeURIComponent(priorities.join(',')));
    if (state.filterCalendar !== 'all') params.push('calendar=' + encodeURIComponent(state.filterCalendar));
    if (state.filterAssignee) params.push('assignee=' + encodeURIComponent(state.filterAssignee));
    if (state.taskSort !== 'created') params.push('sort=' + encodeURIComponent(state.taskSort));
    params.push('page=' + state.page);
    params.push('pageSize=' + state.pageSize);
    return params.join('&');
  }

  // Only the newest request is allowed to land: typing in the search box fires
  // several, and they can come back out of order.
  var taskFetchToken = 0;

  function fetchTasks() {
    var token = ++taskFetchToken;
    return api('GET', '/api/tasks?' + taskQueryParams()).then(function (res) {
      if (token !== taskFetchToken || !res) return;
      state.tasks = res.tasks || [];
      state.taskMeta = {
        page: res.page, pageSize: res.pageSize, total: res.total,
        totalPages: res.totalPages, statusCounts: res.statusCounts || {}
      };
      // The server clamps the page when the result shrank under us.
      state.page = res.page;
    }).catch(function () {});
  }

  function fetchSummary() {
    return api('GET', '/api/tasks/summary').then(function (res) {
      if (res) state.summary = res;
    }).catch(function () {});
  }

  // The "Due today" card is its own query: the list is one page, and today's
  // work may sit on any page or under any department.
  function fetchToday() {
    return api('GET', '/api/tasks/today').then(function (list) {
      state.todayTasks = list || [];
    }).catch(function () {});
  }

  function refreshTasks() {
    return Promise.all([fetchTasks(), fetchSummary(), fetchToday()]).then(render);
  }

  // A task opened from the today card may not be on the list's current page.
  function findLoadedTask(id) {
    return state.tasks.filter(function (x) { return x.id === id; })[0]
      || state.todayTasks.filter(function (x) { return x.id === id; })[0]
      || state.extraTasks[id]
      || null;
  }

  var searchTimer = null;
  function scheduleSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      searchTimer = null;
      fetchTasks().then(render);
    }, 250);
  }

  function listScrollKey() {
    return 'list:' + state.selectedNode + ':' + state.activeTab + ':' + state.page + ':' + state.searchQuery.trim() + ':' + (isNarrowScreen() ? 'cards' : state.viewMode);
  }

  function statusCount(id) {
    var n = state.taskMeta.statusCounts[id];
    return typeof n === 'number' ? n : 0;
  }

  // ---- accessibility ----
  // Every control in this app is a styled div carrying data-action, which a
  // keyboard cannot reach and a screen reader reads as nothing. Rather than
  // repeat tabindex/role across sixty-odd markup strings (and miss some), the
  // whole tree is fixed up after each render.
  var NATIVE_CONTROLS = { INPUT: true, SELECT: true, TEXTAREA: true, BUTTON: true, A: true };

  function isNativeControl(el) {
    return !!NATIVE_CONTROLS[String(el.tagName).toUpperCase()];
  }

  function applyA11y(root) {
    var controls = root.querySelectorAll('[data-action]');
    for (var i = 0; i < controls.length; i++) {
      var el = controls[i];
      // Checkboxes and radios are already focusable and already announce
      // themselves; calling them buttons would misreport what they do.
      if (isNativeControl(el)) continue;
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
      if (!el.hasAttribute('aria-label') && el.hasAttribute('title')) {
        el.setAttribute('aria-label', el.getAttribute('title'));
      }
    }
    // Most form labels sit next to their field rather than wrapping it, so
    // without `for` they label nothing. A label that already wraps its control
    // is correctly associated and must be left alone - linking it to a sibling
    // would hand it to the wrong field.
    var labels = root.querySelectorAll('label:not([for])');
    for (var j = 0; j < labels.length; j++) {
      if (labels[j].querySelector('input, select, textarea')) continue;
      var field = labels[j].parentNode && labels[j].parentNode.querySelector('input[id], select[id], textarea[id]');
      if (field) labels[j].setAttribute('for', field.id);
    }
  }

  // ---- render loop ----
  // A re-render throws away the focused element, which for a keyboard user
  // means focus falls back to the body after every click. Controls are matched
  // across renders by the action they carry.
  function focusKey(el) {
    if (!el || !el.getAttribute) return null;
    var action = el.getAttribute('data-action');
    if (!action) return null;
    return action + '|' + (el.getAttribute('data-id') || '') + '|' + (el.getAttribute('data-hex') || '');
  }

  // Regions render() has just put back where they were, and the offset it
  // gave each. Putting a scroll position back makes the browser fire a scroll
  // event a frame later; isRestoredScroll lets the "scrolling closes an open
  // list" listener tell that echo from the reader actually scrolling.
  var restoredScrolls = [];

  function isRestoredScroll(el) {
    for (var i = 0; i < restoredScrolls.length; i++) {
      if (restoredScrolls[i].el !== el) continue;
      if (el.scrollTop === restoredScrolls[i].top && el.scrollLeft === restoredScrolls[i].left) return true;
      restoredScrolls.splice(i, 1);
      return false;
    }
    return false;
  }

  function render() {
    var active = document.activeElement;
    var restore = null;
    var restoreAction = null;
    if (active && active.id && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA')) {
      restore = { id: active.id, start: active.selectionStart, end: active.selectionEnd };
    } else {
      restoreAction = focusKey(active);
    }

    var root = document.getElementById('root');

    // Replacing the tree resets every scroll position to the top, so reading
    // a long list or the guide meant being thrown back up whenever anyone else
    // changed anything. Scroll regions carry a key; a region keeps its offset
    // while its key is the same. Keys include what the region is showing, so
    // moving to another department, tab or page still starts at the top.
    var scrolls = {};
    var scrollers = root.querySelectorAll('[data-scroll-key]');
    for (var si = 0; si < scrollers.length; si++) {
      var se = scrollers[si];
      if (se.scrollTop || se.scrollLeft) scrolls[se.getAttribute('data-scroll-key')] = [se.scrollTop, se.scrollLeft];
    }

    root.innerHTML = state.user ? (state.user.mustChangePassword ? PasswordScreen() : App()) : AuthScreen();

    // Matched by comparing the attribute, not by building a selector: a key
    // can carry the search text, and a stray quote or backslash in it would
    // make an invalid selector and throw out of render().
    var fresh = root.querySelectorAll('[data-scroll-key]');
    restoredScrolls = [];
    for (var fi = 0; fi < fresh.length; fi++) {
      var saved = scrolls[fresh[fi].getAttribute('data-scroll-key')];
      if (saved) {
        fresh[fi].scrollTop = saved[0];
        fresh[fi].scrollLeft = saved[1];
        restoredScrolls.push({ el: fresh[fi], top: fresh[fi].scrollTop, left: fresh[fi].scrollLeft });
      }
    }
    applyA11y(root);
    placeMSelectMenu(root);

    // Giving focus back must not scroll: the region was just put back where
    // the reader had it, and a focus that scrolls it again (to reveal the
    // title field at the top of a dialog they had scrolled down, say) both
    // yanks the view and counts as a scroll to the listener that closes open
    // lists.
    if (restore) {
      var el = document.getElementById(restore.id);
      if (el) {
        el.focus({ preventScroll: true });
        if (restore.start !== null && restore.start !== undefined && el.setSelectionRange) {
          try { el.setSelectionRange(restore.start, restore.end); } catch (e) {}
        }
      }
    } else if (restoreAction) {
      var all = root.querySelectorAll('[data-action]');
      for (var k = 0; k < all.length; k++) {
        if (focusKey(all[k]) === restoreAction) { all[k].focus({ preventScroll: true }); break; }
      }
    }

    // A dialog that opens without taking focus leaves the keyboard behind it,
    // still tabbing through the page underneath.
    if (pendingDialogFocus) {
      pendingDialogFocus = false;
      var dialogs = root.querySelectorAll('[role="dialog"]');
      var dialog = dialogs[dialogs.length - 1];
      if (dialog) {
        var first = dialog.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [data-action]');
        (first || dialog).focus();
      }
    }
  }

  var pendingDialogFocus = false;
  function focusDialogOnNextRender() { pendingDialogFocus = true; }

  function setState(patch) { Object.assign(state, patch); render(); }

  // ---- bootstrap / auth ----
  function loadSettings() {
    return api('GET', '/api/settings').then(function (s) {
      if (s) state.setupRequired = !!s.setupRequired;
      if (s && s.appName) {
        state.appName = s.appName;
        state.appNameDraft = s.appName;
        document.title = s.appName;
      }
    }).catch(function () {});
  }

  function bootstrap() {
    loadSettings().then(function () {
      if (state.setupRequired && !state.user) state.authView = 'register';
      render();
      refreshFavicon();
    });
    api('GET', '/api/me').then(function (user) {
      state.user = user;
      return user.mustChangePassword ? null : loadAll();
    }).catch(function () {
      state.user = null;
    }).then(render);

    if (window.matchMedia) {
      var widthMq = window.matchMedia(NARROW_QUERY);
      // The layout differs either side of the breakpoint, so crossing it
      // redraws; what is folded or open stays as the reader left it.
      var onWidth = function () { render(); };
      if (widthMq.addEventListener) widthMq.addEventListener('change', onWidth);
      else if (widthMq.addListener) widthMq.addListener(onWidth);

      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onSchemeChange = function () {
        if (state.themeMode === 'system') { render(); refreshFavicon(); }
      };
      if (mq.addEventListener) mq.addEventListener('change', onSchemeChange);
      else if (mq.addListener) mq.addListener(onSchemeChange);
    }
  }

  function loadAll() {
    return Promise.all([api('GET', '/api/departments'), fetchTasks(), fetchToday(), fetchSummary()]).then(function (r) {
      state.departments = r[0] || [];
      return Promise.all([loadUsers(), loadMembers(), loadActivity(), loadNotifications()]);
    }).then(subscribeEvents);
  }

  // Every approved member can read the member directory - it is only who
  // exists and what to call them, which is what an assignee picker needs.
  function loadMembers() {
    return api('GET', '/api/members').then(function (m) {
      state.members = m || [];
    }).catch(function () { state.members = []; });
  }

  function memberById(id) {
    return state.members.filter(function (m) { return m.id === id; })[0] || null;
  }

  // Only an administrator can read the account list; for everyone else the
  // endpoint answers 403 and there is nothing to show.
  function loadUsers() {
    if (!isAdmin()) { state.users = []; return Promise.resolve(); }
    return api('GET', '/api/users').then(function (users) {
      state.users = users || [];
    }).catch(function () { state.users = []; });
  }

  // ---- live updates ----
  // The server says only which collection changed; we refetch that collection.
  // Several changes can land at once (deleting a department touches four), so
  // the topics are pooled and applied in one pass, then rendered once.
  var live = { source: null, pending: {}, timer: null };

  function subscribeEvents() {
    if (live.source || typeof window.EventSource !== 'function') return;
    var src = new EventSource('/api/events');
    live.source = src;
    src.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || !msg.topic) return;
      if (msg.origin === CLIENT_ID) return;
      live.pending[msg.topic] = true;
      if (live.timer) return;
      live.timer = setTimeout(function () {
        live.timer = null;
        var topics = Object.keys(live.pending);
        live.pending = {};
        applyRemoteChanges(topics);
      }, 250);
    };
    // EventSource reconnects on its own; nothing to do but let it.
    src.onerror = function () {};
  }

  function unsubscribeEvents() {
    if (!live.source) return;
    live.source.close();
    live.source = null;
    live.pending = {};
    if (live.timer) { clearTimeout(live.timer); live.timer = null; }
  }

  function applyRemoteChanges(topics) {
    var jobs = [];
    if (topics.indexOf('tasks') !== -1) {
      jobs.push(fetchTasks());
      jobs.push(fetchSummary());
      jobs.push(fetchToday());
    }
    if (topics.indexOf('departments') !== -1) {
      jobs.push(api('GET', '/api/departments').then(function (d) { state.departments = d || []; }));
    }
    if (topics.indexOf('activity') !== -1) jobs.push(loadActivity());
    if (topics.indexOf('users') !== -1) jobs.push(loadUsers());
    if (topics.indexOf('members') !== -1) jobs.push(loadMembers());
    if (topics.indexOf('settings') !== -1) jobs.push(loadSettings());
    // Only worth refetching a thread while its task is actually open.
    var openId = currentTaskId();
    if (topics.indexOf('comments') !== -1 && openId) jobs.push(loadComments(openId));
    if (topics.indexOf('checklist') !== -1 && openId) jobs.push(loadChecklist(openId));
    if (topics.indexOf('attachments') !== -1 && state.detailTaskId) jobs.push(loadAttachments(state.detailTaskId));
    if (topics.indexOf('tasks') !== -1 && state.detailTaskId) jobs.push(loadDetailTask(state.detailTaskId));
    if (topics.indexOf('notifications') !== -1) jobs.push(loadNotifications());
    if ((topics.indexOf('trash') !== -1 || topics.indexOf('tasks') !== -1) && state.trashModalPhase === 'open') {
      jobs.push(loadTrash());
    }
    if (topics.indexOf('backups') !== -1 && state.backupModalPhase === 'open') jobs.push(loadBackups());
    if (topics.indexOf('reminders') !== -1 && state.reminderModalPhase === 'open') jobs.push(loadReminders());

    Promise.all(jobs).then(function () {
      // Someone else may have deleted the department we are looking at.
      if (state.selectedNode !== 'all' && state.selectedNode !== 'mine' && !findDept(state.selectedNode)) {
        state.selectedNode = 'all';
        nav.nodeTarget = 'all';
      }
      if (topics.indexOf('settings') !== -1) refreshFavicon();
      render();
    }).catch(function () {});
  }

  function pendingUserCount() {
    return state.users.filter(function (u) { return u.status === 'pending'; }).length;
  }

  function switchAuthView(view) { setState({ authView: view, authError: '', authNotice: '' }); }

  function submitLogin() {
    var f = state.authForm;
    if (!f.username || !f.password) { setState({ authError: T('Enter a username and password.') }); return; }
    api('POST', '/api/login', { username: f.username, password: f.password }).then(function (user) {
      state.user = user;
      return user.mustChangePassword ? null : loadAll();
    }).then(function () {
      setState({ authForm: { username: '', password: '', displayName: '' }, authError: '', authNotice: '' });
    }).catch(function (e) { setState({ authError: e.message, authNotice: '' }); });
  }

  function submitRegister() {
    var f = state.authForm;
    if (!f.username || !f.password || !f.displayName) { setState({ authError: T('Fill in every field.') }); return; }
    if (f.password.length < 8) { setState({ authError: T('Password must be at least 8 characters.') }); return; }
    api('POST', '/api/register', { username: f.username, password: f.password, displayName: f.displayName }).then(function (res) {
      // Everyone after the very first account is created pending, and the
      // server hands back a notice instead of a session.
      if (res && res.status === 'pending') {
        setState({
          authView: 'login', authError: '', authNotice: TE(res.message),
          authForm: { username: '', password: '', displayName: '' }
        });
        return null;
      }
      state.user = res;
      state.setupRequired = false;
      return loadAll().then(function () {
        setState({ authForm: { username: '', password: '', displayName: '' }, authError: '', authNotice: '' });
      });
    }).catch(function (e) { setState({ authError: e.message, authNotice: '' }); });
  }

  function logout() {
    unsubscribeEvents();
    api('POST', '/api/logout').catch(function () {}).then(function () {
      state.user = null;
      state.departments = []; state.tasks = []; state.todayTasks = []; state.activity = [];
      state.notifications = []; state.notifUnread = 0; state.extraTasks = {}; notifMaxId = 0;
      state.detailPhase = 'closed'; state.detailTaskId = null; state.detailTask = null; state.lightbox = null;
      state.passwordModalPhase = 'closed'; state.resetResult = null;
      state.selectedNode = 'all'; state.activeTab = 'all'; state.page = 1; state.accountOpen = false;
      render();
    });
  }

  function updateField(formKey, field, value) {
    var next = Object.assign({}, state[formKey]);
    next[field] = value;
    var patch = {}; patch[formKey] = next;
    setState(patch);
  }

  // Same update as updateField, but without a full re-render: typing into a
  // plain text field doesn't need the whole page rebuilt on every keystroke
  // (that was tearing down and remounting the input itself, which reset its
  // focus outline and replayed entrance animations on every character).
  // The native input already shows what was typed; we just need the value
  // in state for when the form is submitted.
  function updateFieldSilent(formKey, field, value) {
    var next = Object.assign({}, state[formKey]);
    next[field] = value;
    state[formKey] = next;
  }

  // ---- navigation ----
  // An animation class has to be present on the render that follows a change
  // and gone by the next one, or it replays every time anything re-renders.
  // playOnce holds the class under a key for its duration and then clears it.
  var oneShot = {};
  var oneShotTokens = {};

  function playOnce(key, cls, ms) {
    var token = (oneShotTokens[key] || 0) + 1;
    oneShotTokens[key] = token;
    oneShot[key] = cls;
    setTimeout(function () {
      if (oneShotTokens[key] !== token) return;
      delete oneShot[key];
      render();
    }, ms);
  }

  function oneShotClass(key) { return oneShot[key] ? ' ' + oneShot[key] : ''; }

  // render() rebuilds the whole tree, so anything that animates on appearing
  // would replay that entrance every time something re-renders while it is
  // open - and with live updates, that is whenever anyone else changes
  // anything. motion() remembers when a thing appeared: a re-render that lands
  // mid-entrance resumes the animation where it was (a negative delay), and
  // once it has finished it does not animate again. An exit holds its final
  // frame instead of snapping back to visible.
  var motionStart = {};
  function motion(key, active, cls, ms, holdEnd) {
    if (!active) { delete motionStart[key]; return { cls: '', style: '' }; }
    if (motionStart[key] == null) motionStart[key] = Date.now();
    var t = Date.now() - motionStart[key];
    if (t >= ms) return holdEnd ? { cls: cls, style: 'animation-delay:-' + ms + 'ms;' } : { cls: '', style: '' };
    return { cls: cls, style: 'animation-delay:-' + t + 'ms;' };
  }

  function modalMotion(name, closing) {
    var cardIn = motion(name + ':in', !closing, 'card-in', 390);
    var cardOut = motion(name + ':out', closing, 'card-out', 240, true);
    var dimIn = motion(name + ':dimIn', !closing, 'overlay-in', 300);
    var dimOut = motion(name + ':dimOut', closing, 'overlay-out', 240, true);
    var card = closing ? cardOut : cardIn;
    var dim = closing ? dimOut : dimIn;
    return { card: card.cls, cardStyle: card.style, dim: dim.cls, dimStyle: dim.style };
  }

  var TREE_ANIM_MS = 360;
  var expandTokens = {};

  // The keyframes only play while the class is on the element, and the class
  // has to come off afterwards or an unrelated re-render would replay the
  // whole expand. Same self-clearing shape as the view toggle and the drawers.
  function toggleExpand(id) {
    var next = Object.assign({}, state.expanded);
    next[id] = !next[id];
    var anim = Object.assign({}, state.expandAnim);
    anim[id] = next[id] ? 'anim-expand' : 'anim-collapse';
    var token = (expandTokens[id] || 0) + 1;
    expandTokens[id] = token;
    setState({ expanded: next, expandAnim: anim });
    setTimeout(function () {
      if (expandTokens[id] !== token) return;
      var cleared = Object.assign({}, state.expandAnim);
      delete cleared[id];
      setState({ expandAnim: cleared });
    }, TREE_ANIM_MS);
  }

  function selectNode(id) {
    if (nav.nodeTarget === id) return;
    nav.nodeTarget = id;
    var token = ++nav.nodeToken;
    setState({ contentAnim: 'out' });
    setTimeout(function () {
      if (nav.nodeToken !== token) return;
      playOnce('node', 'anim-select', 330);
      setState({ selectedNode: id, contentAnim: 'in', page: 1 });
      fetchTasks().then(render);
      // Closing the drawer here (rather than as soon as the tap lands) means
      // the user still sees which department they picked before it slides
      // away, instead of the drawer vanishing under their finger.
      closeMobileNav();
      setTimeout(function () { if (nav.nodeToken === token) setState({ contentAnim: 'settled' }); }, CONTENT_IN_MS);
    }, CONTENT_OUT_MS);
  }

  function setTab(id) {
    if (nav.tabTarget === id) return;
    nav.tabTarget = id;
    var token = ++nav.tabToken;
    setState({ contentAnim: 'out' });
    setTimeout(function () {
      if (nav.tabToken !== token) return;
      playOnce('tab', 'anim-select', 330);
      setState({ activeTab: id, contentAnim: 'in', page: 1 });
      fetchTasks().then(render);
      setTimeout(function () { if (nav.tabToken === token) setState({ contentAnim: 'settled' }); }, CONTENT_IN_MS);
    }, CONTENT_OUT_MS);
  }

  function clearSearch() { setState({ searchQuery: '', page: 1 }); fetchTasks().then(render); }
  function setViewMode(mode) {
    if (state.viewMode === mode) return;
    // A full re-render always mounts a fresh thumb node, so a CSS `transition`
    // on it never has a "before" state to animate from — it would just snap.
    // A CSS `animation` (keyframes) plays on mount regardless, so we drive
    // the slide with one instead, self-clearing after it finishes so it
    // doesn't replay on a later, unrelated re-render.
    var anim = mode === 'grid' ? 'slide-right' : 'slide-left';
    state.viewToggleAnim = anim;
    setState({ viewMode: mode });
    setTimeout(function () {
      if (state.viewToggleAnim === anim) setState({ viewToggleAnim: null });
    }, 300);
  }
  // Turning the page moves the same way changing a tab does, instead of the
  // rows swapping out from under the eye.
  function goToPage(next) {
    var token = ++nav.tabToken;
    setState({ contentAnim: 'out' });
    setTimeout(function () {
      if (nav.tabToken !== token) return;
      state.page = next;
      fetchTasks().then(function () {
        setState({ contentAnim: 'in' });
        setTimeout(function () { if (nav.tabToken === token) setState({ contentAnim: 'settled' }); }, CONTENT_IN_MS);
      });
    }, CONTENT_OUT_MS);
  }
  function prevPage() {
    if (state.page <= 1) return;
    goToPage(state.page - 1);
  }
  function nextPage() {
    if (state.page >= (state.taskMeta.totalPages || 1)) return;
    goToPage(state.page + 1);
  }
  var DROPDOWN_OUT_MS = 225;

  function openDropdown(which, extra) {
    var patch = { notifOpen: which === 'notif', accountOpen: which === 'account', filterOpen: which === 'filter', brandOpen: which === 'brand', dropdownClosing: '' };
    if (extra) Object.assign(patch, extra);
    setState(patch);
  }

  function whichDropdownOpen() {
    if (state.notifOpen) return 'notif';
    if (state.accountOpen) return 'account';
    if (state.filterOpen) return 'filter';
    if (state.brandOpen) return 'brand';
    return '';
  }

  // Keeps the panel mounted for the length of its exit animation.
  function closeDropdowns() {
    var open = whichDropdownOpen();
    if (!open) return false;
    setState({ notifOpen: false, accountOpen: false, filterOpen: false, brandOpen: false, dropdownClosing: open });
    setTimeout(function () {
      if (state.dropdownClosing === open) setState({ dropdownClosing: '' });
    }, DROPDOWN_OUT_MS);
    return true;
  }

  function toggleDropdown(which, extra) {
    if (whichDropdownOpen() === which) closeDropdowns();
    else openDropdown(which, extra);
  }

  function dropdownMotion(which) {
    var closing = state.dropdownClosing === which;
    var enter = motion('dd:' + which + ':in', whichDropdownOpen() === which, 'dropdown-in', 285);
    var exit = motion('dd:' + which + ':out', closing, 'dropdown-out', DROPDOWN_OUT_MS, true);
    return closing ? exit : enter;
  }

  function dropdownClass(which) { return ('dropdown-panel ' + dropdownMotion(which).cls).trim(); }
  function dropdownStyle(which) { return dropdownMotion(which).style; }

  function toggleFilterOpen() { toggleDropdown('filter'); }
  function toggleFilterPriority(p) {
    var next = Object.assign({}, state.filterPriority);
    next[p] = !next[p];
    setState({ filterPriority: next, page: 1 });
    fetchTasks().then(render);
  }
  function setFilterCalendar(v) { setState({ filterCalendar: v, page: 1 }); fetchTasks().then(render); }
  function setFilterAssignee(v) { setState({ filterAssignee: v, page: 1 }); fetchTasks().then(render); }
  function setTaskSort(v) {
    try { localStorage.setItem(TASK_SORT_KEY, v); } catch (e) {}
    setState({ taskSort: v, page: 1 });
    fetchTasks().then(render);
  }
  function clearFilters() {
    setState({ filterPriority: { High: true, Medium: true, Low: true }, filterCalendar: 'all', filterAssignee: '', page: 1 });
    fetchTasks().then(render);
  }
  function toggleNotif() {
    // Opening straight onto activity when nothing is waiting for you.
    var tab = state.notifUnread > 0 ? 'mine' : (unreadActivityCount() > 0 ? 'activity' : state.bellTab);
    toggleDropdown('notif', { bellTab: tab });
  }
  function markAllNotifsRead() {
    if (state.bellTab === 'mine') markNotificationsRead(null); else markActivitySeen();
  }

  // ---- mobile drawers (departments list + calendar panel) ----
  // Below the mobile breakpoint the department list and the calendar panel
  // are off-canvas drawers instead of permanent columns (see styles.css).
  // render() replaces the whole DOM tree on every state change, so a plain
  // CSS `transition` on open/close never has a "before" frame to animate
  // from - same reason setViewMode below drives its thumb with a keyframe
  // `animation` instead. mobileNavAnim/mobileCalendarAnim hold a one-shot
  // 'anim-open'/'anim-close' class that plays the slide once and then
  // self-clears, so it does not replay on every unrelated re-render while
  // the drawer sits open (e.g. ticking a task inside it).
  var MOBILE_DRAWER_OPEN_MS = 330, MOBILE_DRAWER_CLOSE_MS = 300;

  function setMobileNav(open) {
    var token = ++nav.mobileNavToken;
    setState({ mobileNavOpen: open, mobileNavAnim: open ? 'anim-open' : 'anim-close' });
    setTimeout(function () {
      if (nav.mobileNavToken === token) setState({ mobileNavAnim: null });
    }, open ? MOBILE_DRAWER_OPEN_MS : MOBILE_DRAWER_CLOSE_MS);
  }
  function closeMobileNav() { if (state.mobileNavOpen) setMobileNav(false); }
  // The department list is a drawer on every screen: it slides in over the
  // page rather than taking a column from it, and slides away again once a
  // department is picked or anything outside it is clicked.
  function toggleSidebar() { toggleMobileNav(); }

  function toggleMobileNav() {
    if (state.mobileCalendarOpen) closeMobileCalendar();
    setMobileNav(!state.mobileNavOpen);
  }

  function setMobileCalendar(open) {
    var token = ++nav.mobileCalendarToken;
    setState({ mobileCalendarOpen: open, mobileCalendarAnim: open ? 'anim-open' : 'anim-close' });
    setTimeout(function () {
      if (nav.mobileCalendarToken === token) setState({ mobileCalendarAnim: null });
    }, open ? MOBILE_DRAWER_OPEN_MS : MOBILE_DRAWER_CLOSE_MS);
  }
  function closeMobileCalendar() { if (state.mobileCalendarOpen) setMobileCalendar(false); }
  function toggleMobileCalendar() {
    if (state.mobileNavOpen) closeMobileNav();
    setMobileCalendar(!state.mobileCalendarOpen);
  }

  function closeMobileDrawers() { closeMobileNav(); closeMobileCalendar(); }

  // Escape backs out of the innermost thing that is open, so it never skips
  // past a dialog to close a drawer behind it.
  function dismissTopmost() {
    if (state.openSelect) { closeMSelect(); return true; }
    if (state.lightbox) { closeLightbox(); return true; }
    if (state.iconPickerOpen) { closeIconPicker(); return true; }
    if (state.mention) { setState({ mention: null }); return true; }
    if (state.passwordModalPhase === 'open') { closePasswordModal(); return true; }
    if (state.newTaskModalPhase === 'open') { closeTaskModal(); return true; }
    if (state.detailPhase === 'open') { closeTaskDetail(); return true; }
    if (state.trashModalPhase === 'open') { closeTrash(); return true; }
    if (state.appPwModalPhase === 'open') { closeAppPasswords(); return true; }
    if (state.backupModalPhase === 'open') { closeBackups(); return true; }
    if (state.reminderModalPhase === 'open') { closeReminders(); return true; }
    if (state.addDeptModalPhase === 'open') { closeAddDept(); return true; }
    if (state.mappingModalPhase === 'open') { closeMapping(); return true; }
    if (state.usersModalPhase === 'open') { closeUsers(); return true; }
    if (state.guideModalPhase === 'open') { closeGuide(); return true; }
    if (state.accentPickerPhase === 'open') { closeAccentPicker(); return true; }
    if (closeDropdowns()) return true;
    if (state.mobileNavOpen || state.mobileCalendarOpen) { closeMobileDrawers(); return true; }
    return false;
  }

  function openMobileSearch() {
    setState({ mobileSearchOpen: true });
    // render()'s own focus-restore only refocuses an input that already had
    // focus before the re-render; this one was just born, so it needs an
    // explicit focus once it exists in the DOM.
    setTimeout(function () {
      var el = document.getElementById('mobileSearchInput');
      if (el) el.focus();
    }, 0);
  }
  var SEARCH_OUT_MS = 255;

  function closeMobileSearch() {
    if (!state.mobileSearchOpen) return;
    setState({ mobileSearchClosing: true, mobileSearchOpen: false, searchQuery: '', page: 1 });
    fetchTasks().then(render);
    setTimeout(function () {
      if (state.mobileSearchClosing) setState({ mobileSearchClosing: false });
    }, SEARCH_OUT_MS);
  }
  function toggleFeeds() {
    playOnce('feeds', state.feedsOpen ? 'anim-collapse' : 'anim-expand', TREE_ANIM_MS);
    setState({ feedsOpen: !state.feedsOpen });
  }

  function toggleAccount() { toggleDropdown('account', { appNameDraft: state.appName, displayNameDraft: state.user.displayName }); }

  function openAccentPicker() {
    nav.accentToken++;
    setState({ accentPickerPhase: 'open', notifOpen: false, accountOpen: false, filterOpen: false });
  }
  function closeAccentPicker() {
    if (state.accentPickerPhase !== 'open') return;
    var token = ++nav.accentToken;
    setState({ accentPickerPhase: 'closing' });
    setTimeout(function () { if (nav.accentToken === token) setState({ accentPickerPhase: 'closed' }); }, 160);
  }
  function accentMotion() {
    var closing = state.accentPickerPhase === 'closing';
    var open = state.accentPickerPhase === 'open';
    var enter = motion('accent:in', open, 'accent-pill-open', 270);
    var exit = motion('accent:out', closing, 'accent-pill-close', 240, true);
    return closing ? exit : enter;
  }

  function toggleAccentPicker() {
    if (state.accentPickerPhase === 'closed') openAccentPicker(); else closeAccentPicker();
  }
  function applyAccent(hex, closePicker) {
    try { localStorage.setItem('directive_accent', hex); } catch (e) {}
    playOnce('palette', 'anim-palette', 420);
    if (closePicker) playOnce('swatch:' + hex, 'anim-swatch', 480);
    setState({ accent: hex });
    refreshFavicon();
    if (closePicker) closeAccentPicker();
  }

  function setAccent(hex) { applyAccent(hex, true); }

  function isPresetAccent(hex) { return ACCENT_PRESETS.indexOf((hex || '').toLowerCase()) !== -1; }

  // Typing a hex applies it as soon as it is a whole colour. A half-typed one
  // changes nothing, so nothing re-renders and the field keeps what was typed.
  function setAccentHex(value) {
    var hex = (value || '').trim();
    if (hex.charAt(0) !== '#') hex = '#' + hex;
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) applyAccent(hex.toLowerCase(), false);
  }

  // The preset swatches, a slot that opens the system colour palette, and the
  // hex of whatever is chosen - all three showing and setting the same value.
  function accentControls(c) {
    return ACCENT_PRESETS.map(function (hex) {
        return '<span class="swatch' + (state.accent === hex ? ' active' : '') + oneShotClass('swatch:' + hex) + '" data-action="setAccent" data-hex="' + hex + '" title="' + hex + '" style="background:' + hex + ';"></span>';
      }).join('')
      + '<input type="color" id="accentColorInput" class="swatch swatch-custom' + (isPresetAccent(state.accent) ? '' : ' active') + '" value="' + esc(state.accent) + '" title="' + T('Pick any colour') + '" aria-label="' + T('Pick any colour') + '">'
      + '<input id="accentHexInput" value="' + esc(state.accent) + '" spellcheck="false" maxlength="7" aria-label="' + T('Accent colour hex') + '" style="width:78px; height:26px; padding:0 8px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; background:' + c.surface + '; color:' + c.onSurface + '; font-size:12px; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">';
  }

  var THEME_MODE_ORDER = ['light', 'dark', 'system'];
  function cycleThemeMode() {
    var next = THEME_MODE_ORDER[(THEME_MODE_ORDER.indexOf(state.themeMode) + 1) % THEME_MODE_ORDER.length];
    try { localStorage.setItem('directive_theme_mode', next); } catch (e) {}
    playOnce('themeIcon', 'anim-theme-icon', 510);
    // Switching light/dark repaints every surface; without a settle it reads
    // as a flash rather than a change.
    if (isDarkActive() !== computeDark(next)) playOnce('palette', 'anim-palette', 420);
    setState({ themeMode: next });
    refreshFavicon();
  }

  function computeDark(mode) {
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function saveAppName() {
    var name = (state.appNameDraft || '').trim();
    if (!name || name === state.appName) return;
    api('PUT', '/api/settings', { appName: name }).then(function (s) {
      state.appName = s.appName;
      state.appNameDraft = s.appName;
      document.title = s.appName;
      refreshFavicon();
      render();
    }).catch(function (e) { window.alert(e.message); });
  }

  function saveDisplayName() {
    var name = (state.displayNameDraft || '').trim();
    if (!name || name === state.user.displayName) return;
    api('PUT', '/api/me', { displayName: name }).then(function (u) {
      state.user.displayName = u.displayName;
      state.displayNameDraft = u.displayName;
      render();
    }).catch(function (e) { window.alert(e.message); });
  }

  function pickAppIcon() {
    pickImage(function (img) {
      api('PUT', '/api/settings/icon', img).then(function () {
        state.appIconVersion = Date.now();
        refreshFavicon();
        render();
      }).catch(function (e) { window.alert(e.message); });
    });
  }

  function removeAppIcon() {
    api('DELETE', '/api/settings/icon').then(function () {
      state.appIconVersion = Date.now();
      refreshFavicon();
      render();
    }).catch(function (e) { window.alert(e.message); });
  }

  function pickAvatar() {
    pickImage(function (img) {
      api('PUT', '/api/me/avatar', img).then(function () {
        state.avatarVersion = Date.now();
        render();
      }).catch(function (e) { window.alert(e.message); });
    });
  }

  function removeAvatar() {
    api('DELETE', '/api/me/avatar').then(function () {
      state.avatarVersion = Date.now();
      render();
    }).catch(function (e) { window.alert(e.message); });
  }

  function showCopied(token) {
    state.copiedToken = token;
    render();
    setTimeout(function () {
      if (state.copiedToken === token) setState({ copiedToken: '' });
    }, 1600);
  }

  function copyFeedUrl(token) {
    var url = location.origin + '/calendar/' + token + '.ics';
    var done = function () { showCopied(token); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(function () { window.prompt(T('Copy this link:'), url); });
    } else {
      window.prompt(T('Copy this link:'), url);
    }
  }

  // ---- tasks ----
  var taskFormAtOpen = '';

  function taskFormChanged() {
    return JSON.stringify(state.newTaskForm) !== taskFormAtOpen || !!(state.checklistDraft || '').trim() && !state.editingTaskId;
  }

  function blankTaskForm(deptId) {
    return { title: '', description: '', deptId: deptId || '', assignee: '', assigneeId: 0, priority: 'Medium', due: '', status: 'todo', calendarVisible: false, recurrence: '', checklistItems: [] };
  }

  function openTaskModal() {
    focusDialogOnNextRender();
    nav.taskToken++;
    var dept = state.selectedNode === 'all' || state.selectedNode === 'mine' ? '' : state.selectedNode;
    var form = blankTaskForm(dept);
    taskFormAtOpen = JSON.stringify(form);
    setState({
      newTaskModalPhase: 'open', editingTaskId: null, checklist: [], checklistDraft: '',
      newTaskForm: form
    });
  }

  // A task opened from a notification may not be on any page this tab has
  // loaded, so it is fetched on its own first.
  function openEditTask(id) {
    var t = findLoadedTask(id);
    if (!t) {
      api('GET', '/api/tasks/' + id).then(function (task) {
        state.extraTasks[id] = task;
        openEditTask(id);
      }).catch(function () { window.alert(T('That task is no longer available.')); });
      return;
    }
    focusDialogOnNextRender();
    nav.taskToken++;
    var form = { title: t.title, description: t.description || '', deptId: t.deptId, assignee: t.assignee === 'Unassigned' ? '' : t.assignee, assigneeId: t.assigneeId || 0, priority: t.priority, due: t.dueDate || '', status: t.status, calendarVisible: !!t.calendarVisible, recurrence: t.recurrence || '', checklistItems: [] };
    taskFormAtOpen = JSON.stringify(form);
    setState({ newTaskModalPhase: 'open', editingTaskId: id, newTaskForm: form });
  }

  function loadComments(taskId) {
    return api('GET', '/api/tasks/' + taskId + '/comments').then(function (list) {
      state.comments = list || [];
    }).catch(function () { state.comments = []; });
  }

  function postComment() {
    var body = (state.commentDraft || '').trim();
    var taskId = currentTaskId();
    if (!body || !taskId) return;
    api('POST', '/api/tasks/' + taskId + '/comments', { body: body }).then(function (created) {
      state.commentDraft = '';
      if (created && created.id) playOnce('comment:' + created.id, 'anim-item-in', 390);
      return loadComments(taskId);
    }).then(function () {
      return refreshTasks();
    }).catch(function (e) { window.alert(e.message); });
  }

  function deleteComment(id) {
    if (!window.confirm(T('Delete this comment?'))) return;
    var taskId = currentTaskId();
    api('DELETE', '/api/comments/' + id).then(function () {
      return loadComments(taskId);
    }).then(function () {
      return refreshTasks();
    }).catch(function (e) { window.alert(e.message); });
  }

  function closeTaskModal() {
    if (state.newTaskModalPhase !== 'open') return;
    var token = ++nav.taskToken;
    setState({ newTaskModalPhase: 'closing' });
    setTimeout(function () {
      if (nav.taskToken !== token) return;
      setState({ newTaskModalPhase: 'closed', editingTaskId: null });
    }, MODAL_CLOSE_MS);
  }

  function toggleTaskCalendar() {
    var next = Object.assign({}, state.newTaskForm);
    next.calendarVisible = !next.calendarVisible;
    setState({ newTaskForm: next });
  }

  function finishTaskModal() {
    var token = ++nav.taskToken;
    setState({ newTaskModalPhase: 'closing' });
    setTimeout(function () {
      if (nav.taskToken !== token) return;
      setState({ newTaskModalPhase: 'closed', editingTaskId: null });
    }, MODAL_CLOSE_MS);
  }

  function saveTask() {
    if (state.newTaskModalPhase !== 'open') return;
    var f = state.newTaskForm;
    if (!f.title || !f.title.trim()) return;
    var title = f.title.trim();
    var payload = { title: title, description: (f.description || '').trim(), deptId: f.deptId, assignee: f.assignee.trim(), assigneeId: Number(f.assigneeId) > 0 ? Number(f.assigneeId) : 0, priority: f.priority, dueDate: f.due, status: f.status, calendarVisible: !!f.calendarVisible, recurrence: f.recurrence || '' };

    var req;
    if (state.editingTaskId) {
      req = api('PUT', '/api/tasks/' + state.editingTaskId, payload);
    } else {
      // An item still sitting in the box when Create is pressed was meant to
      // be on the list too.
      var items = (f.checklistItems || []).slice();
      if ((state.checklistDraft || '').trim()) items.push(state.checklistDraft.trim());
      payload.checklist = items;
      req = api('POST', '/api/tasks', payload).then(function (created) {
        state.justAddedTaskId = created.id;
        (function (id) { setTimeout(function () { if (state.justAddedTaskId === id) setState({ justAddedTaskId: null }); }, 1350); })(created.id);
      });
    }
    req.then(refreshTasks).then(function () {
      if (state.detailTaskId && state.detailTaskId === state.editingTaskId) return loadDetailTask(state.detailTaskId);
    }).then(function () {
      finishTaskModal();
    }).catch(function (e) { window.alert(e.message); });
  }

  // Deleting moves the task to the trash, so there is no confirm step -
  // the snackbar offers the way back instead.
  function deleteTask() {
    if (!state.editingTaskId) return;
    var id = state.editingTaskId;
    var t = findLoadedTask(id);
    api('DELETE', '/api/tasks/' + id).then(function () {
      delete state.extraTasks[id];
      return refreshTasks();
    }).then(function () {
      finishTaskModal();
      if (state.detailTaskId === id) closeTaskDetail();
      showSnackbar(T('Moved {task} to the trash', { task: String.fromCharCode(8220) + (t ? t.title : T('task')) + String.fromCharCode(8221) }), 'undoDelete', id);
    }).catch(function (e) { window.alert(e.message); });
  }

  // Ticking a task in the today card. It goes through the status-only route,
  // so a quick tick never resends - and never overwrites - the rest of the task.
  function toggleTodayTask(id) {
    var t = findLoadedTask(id);
    if (!t) return;
    playOnce('today:' + id, 'anim-check', 420);
    var next = t.status === 'done' ? 'todo' : 'done';
    // The same task can be loaded twice - once on the list's page and once in
    // this card, as separate objects - so every copy takes the new state, or
    // the card keeps showing it unticked.
    state.tasks.concat(state.todayTasks).forEach(function (x) {
      if (x.id !== id) return;
      x.status = next;
      // Finished work is never overdue; reopening waits for the server to say.
      if (next === 'done') x.overdue = false;
    });
    render();
    api('PUT', '/api/tasks/' + id + '/status', { status: next })
      .then(function (res) {
        if (next !== 'done') return refreshTasks();
        if (res && res.nextId) showSnackbar(T('Done. The next one is scheduled.'));
        // A finished task leaves the card, but not before the tick has been
        // seen: it lingers checked and struck through, then slides out.
        setTimeout(function () {
          playOnce('todayLeave:' + id, 'anim-item-out', 360);
          render();
          setTimeout(refreshTasks, 360);
        }, 550);
      })
      .catch(function (e) { window.alert(e.message); refreshTasks(); });
  }


  // ---- accounts (administrator) ----
  function openUsers() {
    focusDialogOnNextRender();
    setState({ usersModalPhase: 'open', accountOpen: false });
    loadUsers().then(render);
  }

  function closeUsers() {
    if (state.usersModalPhase !== 'open') return;
    setState({ usersModalPhase: 'closing' });
    setTimeout(function () { setState({ usersModalPhase: 'closed' }); }, MODAL_CLOSE_MS);
  }

  function patchUser(id, body, note) {
    api('PUT', '/api/users/' + id, body).then(function () {
      if (note)      return loadUsers();
    }).then(render).catch(function (e) { window.alert(e.message); });
  }

  function approveUser(id) {
    var u = state.users.filter(function (x) { return x.id === id; })[0];
    if (!u) return;
    if (!u.deptId) {
      window.alert(T('Pick a department for this person first - without one they can read but not add anything.'));
      return;
    }
    patchUser(id, { status: 'active' }, 'Approved ' + u.displayName);
  }

  function setUserStatus(id, status) {
    var u = state.users.filter(function (x) { return x.id === id; })[0];
    if (status === 'disabled' && u && !window.confirm(T('Disable {name}? They will be signed out immediately.', { name: u.displayName }))) return;
    patchUser(id, { status: status }, u ? (status === 'disabled' ? 'Disabled ' + u.displayName : 'Re-enabled ' + u.displayName) : '');
  }

  function setUserRole(id, role) { patchUser(id, { role: role }, ''); }
  function setUserDept(id, deptId) { patchUser(id, { deptId: deptId }, ''); }

  // ---- departments ----
  function openAddDept() {
    focusDialogOnNextRender();
    nav.addDeptToken++;
    setState({ addDeptModalPhase: 'open', newDeptForm: { name: '', parentId: '' } });
  }

  function closeAddDept() {
    if (state.addDeptModalPhase !== 'open') return;
    var token = ++nav.addDeptToken;
    setState({ addDeptModalPhase: 'closing' });
    setTimeout(function () { if (nav.addDeptToken === token) setState({ addDeptModalPhase: 'closed' }); }, MODAL_CLOSE_MS);
  }

  function createDept() {
    var f = state.newDeptForm;
    if (!f.name || !f.name.trim()) return;
    var name = f.name.trim();
    api('POST', '/api/departments', { name: name, parentId: f.parentId || '' }).then(function () {
      if (f.parentId) {
        var next = Object.assign({}, state.expanded);
        next[f.parentId] = true;
        state.expanded = next;
      }
      return api('GET', '/api/departments');
    }).then(function (depts) {
      state.departments = depts;
      var token = ++nav.addDeptToken;
      setState({ addDeptModalPhase: 'closing' });
      setTimeout(function () { if (nav.addDeptToken === token) setState({ addDeptModalPhase: 'closed' }); }, MODAL_CLOSE_MS);
    }).catch(function (e) { window.alert(e.message); });
  }

  // ---- calendar mapping (labels only — the subscribe link always works) ----
  function openMapping(prefillId) {
    focusDialogOnNextRender();
    nav.mappingToken++;
    var pre = prefillId ? findDept(prefillId) : null;
    setState({
      mappingModalPhase: 'open',
      mappingForm: { deptId: prefillId || '', name: pre ? pre.name : '', calendarList: pre ? (pre.calendarList || '') : '', tag: pre ? (pre.tag || '') : '' }
    });
  }

  function selectMappingDept(id) {
    var d = id ? findDept(id) : null;
    setState({ mappingForm: { deptId: id, name: d ? d.name : '', calendarList: d ? (d.calendarList || '') : '', tag: d ? (d.tag || '') : '' } });
  }

  // Deleting a department keeps its tasks - the server clears
  // their department rather than removing them - but that also puts them out
  // of every member's reach, so it refuses until we confirm, and tells us what
  // is attached so the confirmation can say so.
  function deleteDept() {
    var f = state.mappingForm;
    if (!f.deptId) return;
    var id = f.deptId;
    var label = nodeLabel(id);
    api('DELETE', '/api/departments/' + id).then(function () {
      finishDeptDelete(id, label);
    }).catch(function (e) {
      if (e.status !== 409 || !e.dependents) { window.alert(e.message); return; }
      var d = e.dependents;
      var parts = [];
      if (d.children) parts.push(T(d.children === 1 ? '{n} sub-department (deleted too)' : '{n} sub-departments (deleted too)', { n: d.children }));
      if (d.tasks) parts.push(T(d.tasks === 1 ? '{n} task (kept, but left without a department)' : '{n} tasks (kept, but left without a department)', { n: d.tasks }));
      if (d.members) parts.push(T(d.members === 1 ? '{n} member (will need a new department before they can change anything)' : '{n} members (will need a new department before they can change anything)', { n: d.members }));
      var nl = String.fromCharCode(10);
      if (!window.confirm(T('Delete {name}?', { name: '"' + label + '"' }) + nl + nl + parts.join(nl))) return;
      api('DELETE', '/api/departments/' + id + '?confirm=1')
        .then(function () { finishDeptDelete(id, label); })
        .catch(function (err) { window.alert(err.message); });
    });
  }

  function finishDeptDelete(id, label) {
    loadAll().then(function () {
      // The selected node may be the department that just went away, or one of
      // its children.
      if (state.selectedNode !== 'all' && state.selectedNode !== 'mine' && !findDept(state.selectedNode)) {
        state.selectedNode = 'all';
        nav.nodeTarget = 'all';
      }
      var token = ++nav.mappingToken;
      setState({ mappingModalPhase: 'closing' });
      setTimeout(function () { if (nav.mappingToken === token) setState({ mappingModalPhase: 'closed' }); }, MODAL_CLOSE_MS);
    });
  }

  function closeMapping() {
    if (state.mappingModalPhase !== 'open') return;
    var token = ++nav.mappingToken;
    setState({ mappingModalPhase: 'closing' });
    setTimeout(function () { if (nav.mappingToken === token) setState({ mappingModalPhase: 'closed' }); }, MODAL_CLOSE_MS);
  }

  function saveMapping() {
    var f = state.mappingForm;
    if (!f.deptId) return;
    var body = { calendarList: f.calendarList.trim(), tag: f.tag.trim() };
    if (f.name && f.name.trim()) body.name = f.name.trim();
    api('PUT', '/api/departments/' + f.deptId, body).then(function () {
      return api('GET', '/api/departments');
    }).then(function (depts) {
      state.departments = depts;
      var token = ++nav.mappingToken;
      setState({ mappingModalPhase: 'closing' });
      setTimeout(function () { if (nav.mappingToken === token) setState({ mappingModalPhase: 'closed' }); }, MODAL_CLOSE_MS);
    }).catch(function (e) { window.alert(e.message); });
  }

  // ---- shared task view helpers ----
  function styleMaps(c) {
    var mode = c.dark ? 'dark' : 'light';
    return {
      statusStyle: STATUS_COLORS[mode],
      priorityColor: PRIORITY_COLORS[mode]
    };
  }

  function taskView(t, maps, c) {
    var shownStatus = t.overdue ? 'overdue' : t.status;
    var sm = maps.statusStyle[shownStatus] || maps.statusStyle.todo;
    var av = avatarColors(t.assignee, c.dark);
    var syncIcon = t.calendarVisible
      ? '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="' + c.secondary + '" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="14" height="13" rx="2"></rect><path d="M3 8h14M7 2v4M13 2v4"></path><path d="M7 12l2 2 4-4"></path></svg>'
      : '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="' + c.textMuted + '" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="14" height="13" rx="2"></rect><path d="M3 8h14M7 2v4M13 2v4"></path><path d="M6.5 14l7-6"></path></svg>';
    return {
      statusLabel: (STATUS_META[shownStatus] || STATUS_META.todo).label, statusBg: sm.bg, statusColor: sm.color, statusDot: sm.dot,
      avatarBg: av.bg, avatarColor: av.color,
      priorityColor: maps.priorityColor[t.priority] || c.textMuted,
      dueColor: t.overdue ? c.error : c.onSurfaceVariant,
      dueWeight: t.overdue ? 600 : 400,
      titleColor: t.status === 'done' ? c.onSurfaceVariant : c.onSurface,
      titleDeco: t.status === 'done' ? 'line-through' : 'none',
      syncIcon: syncIcon
    };
  }

  // An assignee linked to an account gets their photo; a free-text one keeps
  // the initials circle it has always had.
  function assigneeAvatarHtml(t, v, sizePx) {
    var fallback = '<div style="width:' + sizePx + 'px; height:' + sizePx + 'px; border-radius:50%; background:' + v.avatarBg + '; color:' + v.avatarColor + '; font-size:' + Math.max(12, Math.round(sizePx * 0.42)) + 'px; font-weight:600; display:flex; align-items:center; justify-content:center; flex-shrink:0;">' + esc(computeInitials(t.assignee)) + '</div>';
    if (!t.assigneeId) return fallback;
    return withImageFallback('/api/users/' + t.assigneeId + '/avatar?v=' + state.avatarVersion, fallback, sizePx, '50%');
  }

  // "2/5" for a task with a checklist, and a loop for one that repeats.
  function taskBadges(t, c) {
    var out = '';
    if (t.checklistTotal) {
      var all = t.checklistDone === t.checklistTotal;
      out += '<span title="' + T('{done} of {total} checklist items done', { done: t.checklistDone, total: t.checklistTotal }) + '" style="display:inline-flex; align-items:center; gap:3px; font-size:12px; font-weight:600; color:' + (all ? c.secondary : c.onSurfaceVariant) + ';">'
        + ICON.checklist + t.checklistDone + '/' + t.checklistTotal + '</span>';
    }
    if (t.attachmentCount) {
      out += '<span title="' + T(t.attachmentCount === 1 ? '{n} attachment' : '{n} attachments', { n: t.attachmentCount }) + '" style="display:inline-flex; align-items:center; gap:3px; font-size:12px; font-weight:600; color:' + c.onSurfaceVariant + ';">'
        + '<svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 9.5l-5.6 5.6a3.5 3.5 0 0 1-5-5L10.2 4a2.3 2.3 0 0 1 3.3 3.3L7.8 13a1.2 1.2 0 0 1-1.7-1.7l5.2-5.2"></path></svg>'
        + t.attachmentCount + '</span>';
    }
    if (t.recurrence) {
      out += '<span title="' + esc(describeRepeat(t.recurrence)) + '" style="display:inline-flex; align-items:center; color:' + c.onSurfaceVariant + ';">' + ICON.repeat + '</span>';
    }
    return out + commentBadge(t, c);
  }

  function commentBadge(t, c) {
    if (!t.commentCount) return '';
    return '<span title="' + T(t.commentCount === 1 ? '{n} comment' : '{n} comments', { n: t.commentCount }) + '" style="display:inline-flex; align-items:center; gap:3px; font-size:12px; font-weight:600; color:' + c.onSurfaceVariant + ';">'
      + '<svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 5.5h12v8H8l-4 3v-11Z"></path></svg>'
      + t.commentCount + '</span>';
  }

  // Under a search result found somewhere the row does not show - its
  // description, checklist, a comment or a file name - a line says where,
  // with the searched words marked.
  function searchMatchHtml(t, c) {
    var m = t.match;
    if (!m || !m.snippet) return '';
    var where = m.in === 'comment' ? T('Comment by {name}', { name: m.author || T('Someone') })
      : m.in === 'checklist' ? T('Checklist') : m.in === 'file' ? T('File') : T('Description');
    var q = state.searchQuery.trim();
    var text = esc(m.snippet);
    if (q) {
      var needle = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(needle, 'gi'), function (x) { return '<mark style="background:' + c.primaryContainer + '; color:' + c.onPrimaryContainer + '; border-radius:3px; padding:0 1px;">' + x + '</mark>'; });
    }
    return '<span class="search-match" style="display:block; font-size:12px; line-height:1.45; color:' + c.onSurfaceVariant + '; margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">'
      + '<b style="font-weight:600;">' + esc(where) + '</b> · ' + text + '</span>';
  }

  function taskRow(t, maps, c) {
    var v = taskView(t, maps, c);
    // One row is one control: the cells sit on the table's own columns through
    // subgrid, so the whole row lights up under the pointer and takes a single
    // stop in the tab order, instead of six cells each reacting on their own.
    return '<div class="interactive task-row' + (t.id === state.justAddedTaskId ? ' row-highlight' : '') + '" data-action="openTask" data-id="' + t.id + '" style="grid-column:1 / -1; display:grid; grid-template-columns:subgrid;">'
      + '<div style="display:flex; align-items:center; padding:13px 16px; border-bottom:1px solid ' + c.outlineVariant + ';">'
      +   '<span style="display:inline-flex; align-items:center; gap:6px; padding:3px 8px; border-radius:var(--r-xs); background:' + v.statusBg + '; color:' + v.statusColor + '; font-size:12px; font-weight:500;"><svg width="8" height="8" viewBox="0 0 20 20" fill="' + v.statusDot + '"><circle cx="10" cy="10" r="8"></circle></svg>' + v.statusLabel + '</span>'
      + '</div>'
      + '<div style="display:flex; flex-direction:column; justify-content:center; min-width:0; padding:13px 16px; border-bottom:1px solid ' + c.outlineVariant + ';">'
      +   '<span style="display:flex; align-items:center; gap:6px; font-size:14px; font-weight:500; color:' + v.titleColor + '; text-decoration:' + v.titleDeco + ';">' + taskIconHtml(t, 16) + '<span>' + esc(t.title) + '</span></span>'
      +   '<span style="display:flex; align-items:center; gap:7px; font-size:12px; color:' + c.onSurfaceVariant + ';">' + esc(nodeLabel(t.deptId)) + taskBadges(t, c) + '</span>'
      +   searchMatchHtml(t, c)
      + '</div>'
      + '<div style="display:flex; align-items:center; gap:8px; padding:13px 16px; border-bottom:1px solid ' + c.outlineVariant + ';">'
      +   assigneeAvatarHtml(t, v, 24)
      +   '<span style="font-size:13px;">' + esc(t.assignee) + '</span>'
      + '</div>'
      + '<div style="display:flex; align-items:center; gap:6px; padding:13px 16px; border-bottom:1px solid ' + c.outlineVariant + '; font-size:13px;"><span style="width:7px; height:7px; border-radius:50%; background:' + v.priorityColor + '; flex-shrink:0;"></span>' + esc(T(t.priority)) + '</div>'
      + '<div style="display:flex; align-items:center; padding:13px 16px; border-bottom:1px solid ' + c.outlineVariant + '; font-size:13px; color:' + v.dueColor + '; font-weight:' + v.dueWeight + ';">' + esc(formatDue(t.dueDate)) + '</div>'
      + '<div style="display:flex; align-items:center; padding:13px 16px; border-bottom:1px solid ' + c.outlineVariant + ';">' + v.syncIcon + '</div>'
      + '</div>';
  }

  function taskCard(t, maps, c) {
    var v = taskView(t, maps, c);
    var cls = 'interactive' + (t.id === state.justAddedTaskId ? ' row-highlight' : '');
    return '<div class="' + cls + '" data-action="openTask" data-id="' + t.id + '" style="background:' + c.surface + '; border:1px solid ' + c.outlineVariant + '; border-radius:var(--r-md); padding:14px; min-width:0; display:flex; flex-direction:column; gap:10px;">'
      + '<div style="display:flex; align-items:center; justify-content:space-between;">'
      +   '<span style="display:inline-flex; align-items:center; gap:6px; padding:3px 8px; border-radius:var(--r-xs); background:' + v.statusBg + '; color:' + v.statusColor + '; font-size:12px; font-weight:500;"><svg width="8" height="8" viewBox="0 0 20 20" fill="' + v.statusDot + '"><circle cx="10" cy="10" r="8"></circle></svg>' + v.statusLabel + '</span>'
      +   v.syncIcon
      + '</div>'
      + '<div><div style="display:flex; align-items:center; gap:6px; font-size:14px; font-weight:500; color:' + v.titleColor + '; text-decoration:' + v.titleDeco + ';">' + taskIconHtml(t, 16) + '<span>' + esc(t.title) + '</span></div><div style="display:flex; align-items:center; gap:7px; font-size:12px; color:' + c.onSurfaceVariant + '; margin-top:2px;">' + esc(nodeLabel(t.deptId)) + taskBadges(t, c) + '</div>' + searchMatchHtml(t, c) + '</div>'
      + '<div style="display:flex; align-items:center; justify-content:space-between;">'
      +   '<div style="display:flex; align-items:center; gap:6px;">' + assigneeAvatarHtml(t, v, 22) + '<span style="font-size:12px;">' + esc(t.assignee) + '</span></div>'
      +   '<span style="font-size:12px; color:' + v.dueColor + '; font-weight:' + v.dueWeight + ';">' + esc(formatDue(t.dueDate)) + '</span>'
      + '</div>'
      + '</div>';
  }

  // ---- auth screen ----
  function inputField(id, form, field, value, placeholder, type, c) {
    placeholder = T(placeholder);
    return '<input id="' + id + '" data-form="' + form + '" data-field="' + field + '" type="' + type + '" value="' + esc(value) + '" placeholder="' + esc(placeholder) + '" style="height:44px; padding:0 14px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:14px; width:100%; background:' + c.surface + '; color:' + c.onSurface + ';"></input>';
  }

  // What the sign-in card says depends on whether this install has any
  // accounts yet: the very first person becomes the administrator and is let
  // straight in, so telling them to wait for approval would be wrong.
  function authBlurb(isRegister) {
    if (state.setupRequired) {
      return isRegister
        ? T('No accounts exist yet. The account you create now becomes the administrator and signs in straight away.')
        : T('No accounts exist yet - create the first one to become the administrator.');
    }
    return isRegister
      ? T('An administrator has to approve your account before you can sign in.')
      : T('Sign in to your department workspace.');
  }

  function AuthScreen() {
    var f = state.authForm;
    var isRegister = state.authView === 'register';
    var c = deriveColors(state.accent, isDarkActive());
    var vars = Object.keys(c).map(function (k) {
      var cssVar = '--' + k.replace(/([A-Z])/g, '-$1').toLowerCase();
      return cssVar + ':' + c[k] + ';';
    }).join('');
    try { document.body.style.background = c.surfaceContainerLow; } catch (e) {}
    try { document.documentElement.setAttribute('data-theme', c.dark ? 'dark' : 'light'); } catch (e) {}
    return '<div style="' + vars + 'min-height:100vh; display:flex; align-items:center; justify-content:center; background:' + c.surfaceContainerLow + '; font-family:inherit;">'
      + '<div class="auth-card" style="width:380px; max-width:92vw; background:' + c.surface + '; border-radius:var(--r-lg); padding:32px; box-shadow:var(--e2); display:flex; flex-direction:column; gap:14px;">'
      +   '<div style="display:flex; align-items:center; gap:10px; margin-bottom:2px;">' + brandIconHtml(c.primaryContainer, c.onPrimaryContainer, 36, false) + '<div style="font-size:18px; font-weight:600; color:' + c.onSurface + ';">' + esc(state.appName) + '</div></div>'
      +   '<div style="font-size:13px; line-height:1.5; color:' + c.onSurfaceVariant + ';">' + esc(authBlurb(isRegister)) + '</div>'
      +   (state.authNotice ? '<div style="font-size:13px; line-height:1.45; color:' + c.onPrimaryContainer + '; background:' + c.primaryContainer + '; padding:10px 12px; border-radius:var(--r-sm);">' + esc(state.authNotice) + '</div>' : '')
      +   (isRegister ? inputField('authDisplayName', 'authForm', 'displayName', f.displayName, 'Display name', 'text', c) : '')
      +   inputField('authUsername', 'authForm', 'username', f.username, 'Username', 'text', c)
      +   inputField('authPassword', 'authForm', 'password', f.password, 'Password', 'password', c)
      +   (state.authError ? '<div style="font-size:13px; color:' + c.error + ';">' + esc(state.authError) + '</div>' : '')
      +   '<div class="interactive" data-action="' + (isRegister ? 'submitRegister' : 'submitLogin') + '" style="height:44px; border-radius:var(--r-sm); background:' + c.primary + '; color:' + c.onPrimary + '; display:flex; align-items:center; justify-content:center; font-weight:600; font-size:14px;">' + (isRegister ? T('Create account') : T('Log in')) + '</div>'
      +   '<div class="interactive" data-action="switchAuthView" data-id="' + (isRegister ? 'login' : 'register') + '" style="text-align:center; font-size:13px; color:' + c.primary + '; font-weight:500;">' + (isRegister ? T('Already have an account? Log in') : T('New here? Create an account')) + '</div>'
      + '</div>'
      + '</div>';
  }

  // ---- main app ----
  function App() {
    var c = deriveColors(state.accent, isDarkActive());
    var vars = Object.keys(c).map(function (k) {
      var cssVar = '--' + k.replace(/([A-Z])/g, '-$1').toLowerCase();
      return cssVar + ':' + c[k] + ';';
    }).join('');
    try { document.body.style.background = c.surface; } catch (e) {}
    try { document.documentElement.setAttribute('data-theme', c.dark ? 'dark' : 'light'); } catch (e) {}

    // The scrim behind a mobile drawer has to stay put for the drawer's own
    // closing animation, not disappear the instant the *Open flag flips -
    // otherwise the backdrop would vanish while the panel is still sliding away.
    var drawerClosing = state.mobileNavAnim === 'anim-close' || state.mobileCalendarAnim === 'anim-close';
    var drawerOpenOrClosing = state.mobileNavOpen || state.mobileCalendarOpen || drawerClosing;
    var scrimClass = 'mobile-scrim ' + ((state.mobileNavOpen || state.mobileCalendarOpen) ? 'open' : 'closing');

    return '<div class="' + oneShotClass('palette').trim() + '" style="' + vars + 'position:relative; display:flex; flex-direction:column; width:100%; height:100vh; height:100dvh; background:' + c.surface + '; color:' + c.onSurface + '; overflow:hidden;">'
      + '<a class="skip-link" href="#task-list">' + T('Skip to tasks') + '</a>'
      + topBar(c)
      + '<div style="flex:1; min-height:0; display:flex; overflow:hidden; position:relative;">'
      +   leftNav(c)
      +   mainContent(c)
      +   rightPanel(c)
      +   (drawerOpenOrClosing ? '<div class="' + scrimClass + '" data-action="closeMobileDrawers"></div>' : '')
      + '</div>'
      + taskDetailModal(c)
      + taskModal(c)
      + addDeptModal(c)
      + mappingModal(c)
      + usersModal(c)
      + guideModal(c)
      + trashModal(c)
      + appPasswordsModal(c)
      + backupsModal(c)
      + remindersModal(c)
      + passwordModal(c)
      + snackbar(c)
      + lightbox(c)
      + mSelectMenu(c)
      + (canCreateTask()
        ? '<div class="interactive fab-new-task" data-action="openTaskModal" aria-label="' + T('New task') + '" style="position:fixed; right:18px; bottom:calc(18px + env(safe-area-inset-bottom, 0px)); z-index:45; align-items:center; justify-content:center; gap:8px; height:56px; padding:0 22px; border-radius:16px; background:' + c.primary + '; color:' + c.onPrimary + '; font-size:15px; font-weight:600; box-shadow:var(--e2);">' + ICON.plus + '<span>' + T('New Task') + '</span></div>'
        : '')
      + '</div>';
  }

  // The logo's menu, for an administrator: the app icon (also the browser
  // tab's) is changed or cleared where it is seen, not from the account menu.
  function brandMenu(c) {
    if (!state.brandOpen && state.dropdownClosing !== 'brand') return '';
    var item = function (action, label, color) {
      return '<div class="interactive" role="menuitem" data-action="' + action + '" style="padding:9px 10px; border-radius:var(--r-sm); font-size:13px; color:' + color + ';">' + T(label) + '</div>';
    };
    return '<div class="' + dropdownClass('brand') + '" role="menu" style="' + dropdownStyle('brand') + 'transform-origin:top left; position:absolute; top:46px; left:0; width:220px; background:' + c.surface + '; border:1px solid ' + c.outlineVariant + '; border-radius:var(--r-md); box-shadow:var(--e2); padding:8px; z-index:60; display:flex; flex-direction:column; gap:2px;">'
      + '<div style="padding:6px 10px 4px 10px; font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('App icon (also used as the favicon)') + '</div>'
      + item('pickAppIcon', 'Upload image', c.onSurface)
      + item('removeAppIcon', 'Use the default icon', c.onSurface)
      + '</div>';
  }

  function topBar(c) {
    var searchClear = state.searchQuery
      ? '<span class="interactive" data-action="clearSearch" style="display:flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:50%; color:' + c.onSurfaceVariant + ';">' + ICON.close + '</span>'
      : '';

    // On a narrow screen the always-open 420px search field left no room for
    // the icon cluster on the right, which got clipped off entirely by the
    // app shell's overflow:hidden. Below the breakpoint it collapses to a
    // single icon (mobile-search-btn, CSS-hidden on desktop) and this early
    // return takes over the whole bar as a full-width field while it's open.
    if (state.mobileSearchOpen || state.mobileSearchClosing) {
      var sm = state.mobileSearchClosing
        ? motion('search:out', true, 'mobile-search-bar-close', SEARCH_OUT_MS, true)
        : motion('search:in', true, 'mobile-search-bar-open', 300);
      if (state.mobileSearchClosing) motion('search:in', false); else motion('search:out', false);
      return '<div class="top-bar ' + sm.cls + '" style="' + sm.style + 'flex-shrink:0; display:flex; align-items:center; gap:10px; background:' + c.surface + '; border-bottom:1px solid ' + c.outlineVariant + ';">'
        + '<span class="interactive" data-action="closeMobileSearch" title="' + T('Back') + '" style="display:flex; align-items:center; justify-content:center; width:36px; height:36px; border-radius:50%; color:' + c.onSurfaceVariant + '; flex-shrink:0;">' + ICON.chevronLeft + '</span>'
        + '<div style="flex:1; display:flex; align-items:center; gap:8px; height:40px; padding:0 14px; border-radius:var(--r-sm); background:' + c.surfaceContainerHigh + '; color:' + c.onSurfaceVariant + ';">'
        +   ICON.search
        +   '<input id="mobileSearchInput" data-field="searchQuery" value="' + esc(state.searchQuery) + '" placeholder="' + T('Search tasks, comments, files') + '" style="border:none; outline:none; background:transparent; flex:1; font-size:14px; color:inherit;"></input>'
        +   searchClear
        + '</div>'
      + '</div>';
    }

    var unread = unreadActivityCount();

    var bellCount = state.notifUnread;
    var mineTab = state.bellTab === 'mine';
    var bellTabBtn = function (id, label, count) {
      var on = state.bellTab === id;
      return '<span class="interactive" role="tab" aria-selected="' + (on ? 'true' : 'false') + '" data-action="setBellTab" data-id="' + id + '" style="display:inline-flex; align-items:center; gap:5px; padding:5px 11px; border-radius:var(--r-sm); font-size:12px; font-weight:600; background:' + (on ? c.primaryContainer : 'transparent') + '; color:' + (on ? c.onPrimaryContainer : c.onSurfaceVariant) + ';">' + label
        + (count > 0 ? '<span style="font-size:12px; padding:0 6px; border-radius:var(--r-sm); background:' + c.error + '; color:#fff;">' + count + '</span>' : '') + '</span>';
    };
    var notifKindIcon = function (kind) {
      if (kind === 'assigned') return '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="7" r="3"></circle><path d="M2.5 16a5.5 5.5 0 0 1 11 0M15 7v5M12.5 9.5h5"></path></svg>';
      if (kind === 'dueToday' || kind === 'dueTomorrow') return '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10.5" r="6.5"></circle><path d="M10 7v3.5l2.5 1.5"></path></svg>';
      if (kind === 'mentioned') return '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="3"></circle><path d="M13 7v4a2 2 0 0 0 4 0v-1a7 7 0 1 0-3 5.7"></path></svg>';
      return '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 5.5h12v8H8l-4 3v-11Z"></path></svg>';
    };
    var mineList = state.notifications.length === 0
      ? '<div style="padding:16px 6px; font-size:13px; line-height:1.5; color:' + c.onSurfaceVariant + ';">' + T('Nothing for you yet. You will hear here when someone assigns you a task, mentions you with @, or comments on your work, and on the morning a task of yours is due.') + '</div>'
      : state.notifications.map(function (n) {
          return '<div class="interactive" data-action="openNotification" data-id="' + n.id + '" style="display:flex; gap:9px; padding:8px 6px; border-radius:var(--r-sm); background:' + (n.read ? 'transparent' : c.surfaceContainerHigh) + '; opacity:' + (n.taskGone ? '.6' : '1') + ';">'
            + '<span style="display:flex; align-items:center; justify-content:center; width:26px; height:26px; border-radius:50%; flex-shrink:0; background:' + (n.read ? c.surfaceContainerHigh : c.primaryContainer) + '; color:' + (n.read ? c.onSurfaceVariant : c.onPrimaryContainer) + ';">' + notifKindIcon(n.kind) + '</span>'
            + '<span style="display:flex; flex-direction:column; gap:2px; min-width:0;">'
            +   '<span style="font-size:13px; line-height:1.45; color:' + c.onSurface + '; font-weight:' + (n.read ? 400 : 500) + ';">' + esc(notificationLine(n)) + '</span>'
            +   '<span style="font-size:12px; color:' + c.onSurfaceVariant + ';">' + esc(formatStamp(n.createdAt)) + (n.taskGone ? ' &middot; ' + T('deleted') : '') + '</span>'
            + '</span>'
            + '</div>';
        }).join('');
    var activityList = state.activity.length === 0
      ? '<div style="padding:16px 6px; font-size:13px; color:' + c.onSurfaceVariant + ';">' + T('Nothing has happened yet.') + '</div>'
      : state.activity.map(function (a) {
          var fresh = !state.activitySeen || a.at > state.activitySeen;
          return '<div style="display:flex; flex-direction:column; gap:2px; padding:8px 6px; border-radius:var(--r-sm); background:' + (fresh ? c.surfaceContainerHigh : 'transparent') + ';">'
            + '<span style="font-size:13px; line-height:1.45; color:' + c.onSurface + ';">' + esc(activityLine(a)) + '</span>'
            + '<span style="font-size:12px; color:' + c.onSurfaceVariant + ';">' + esc(formatStamp(a.at)) + '</span>'
            + '</div>';
        }).join('');
    var canMarkRead = mineTab ? bellCount > 0 : unread > 0;
    var alertsSupported = typeof window.Notification === 'function';

    var notifPanel = (state.notifOpen || state.dropdownClosing === 'notif')
      ? '<div class="' + dropdownClass('notif') + ' bell-panel" style="' + dropdownStyle('notif') + 'position:absolute; top:46px; right:0; width:340px; max-height:440px; display:flex; flex-direction:column; background:' + c.surface + '; border:1px solid ' + c.outlineVariant + '; border-radius:var(--r-md); box-shadow:var(--e2); z-index:60;">'
        + '<div style="display:flex; align-items:center; gap:4px; padding:10px 10px 6px 10px;" role="tablist" aria-label="' + T('Notifications') + '">'
        +   bellTabBtn('mine', T('For you'), bellCount) + bellTabBtn('activity', T('Activity'), 0)
        +   (canMarkRead ? '<span class="interactive" data-action="markAllNotifsRead" style="margin-left:auto; font-size:12px; color:' + c.primary + '; font-weight:500;">' + T('Mark all read') + '</span>' : '')
        + '</div>'
        + '<div data-scroll-key="' + (mineTab ? 'bell-mine' : 'activity') + '" style="flex:1; min-height:0; overflow-y:auto; padding:0 10px 8px 10px;">' + (mineTab ? mineList : activityList) + '</div>'
        + (mineTab && alertsSupported
          ? '<div style="display:flex; align-items:center; gap:8px; padding:8px 14px; border-top:1px solid ' + c.outlineVariant + '; font-size:12px; color:' + c.onSurfaceVariant + ';">'
            + '<span style="flex:1;">' + T('Desktop alerts when this tab is in the background') + '</span>'
            + '<span class="interactive" data-action="toggleDesktopAlerts" role="switch" aria-checked="' + (state.desktopAlerts ? 'true' : 'false') + '" title="' + T('Desktop alerts') + '" style="position:relative; width:34px; height:20px; border-radius:var(--r-sm); flex-shrink:0; background:' + (state.desktopAlerts ? c.primary : c.surfaceContainerHigh) + '; border:1px solid ' + (state.desktopAlerts ? c.primary : c.outline) + ';"><span style="position:absolute; top:2px; left:' + (state.desktopAlerts ? 16 : 2) + 'px; width:14px; height:14px; border-radius:50%; background:' + (state.desktopAlerts ? c.onPrimary : c.outline) + '; transition:left .2s;"></span></span>'
            + '</div>'
          : '')
        + '</div>'
      : '';

    var accountPanel = (state.accountOpen || state.dropdownClosing === 'account')
      ? '<div class="' + dropdownClass('account') + '" style="' + dropdownStyle('account') + 'position:absolute; top:46px; right:0; width:220px; background:' + c.surface + '; border:1px solid ' + c.outlineVariant + '; border-radius:var(--r-md); box-shadow:var(--e2); padding:8px; z-index:60; display:flex; flex-direction:column; gap:2px;">'
        + '<div style="padding:8px 10px 6px 10px; display:flex; align-items:center; gap:10px;">'
          +   avatarHtml(avatarColors(state.user.displayName, c.dark).bg, avatarColors(state.user.displayName, c.dark).color, 44)
          +   '<div style="min-width:0;"><div style="font-size:13px; font-weight:600;">' + esc(state.user.displayName) + '</div><div style="font-size:12px; color:' + c.onSurfaceVariant + ';">@' + esc(state.user.username) + ' · ' + esc(T(state.user.role)) + '</div></div>'
        + '</div>'
        + '<div style="padding:0 10px 6px 10px; display:flex; gap:10px;">'
          +   '<span class="interactive" data-action="pickAvatar" style="font-size:12px; font-weight:500; color:' + c.primary + ';">' + T('Change photo') + '</span>'
          +   '<span class="interactive" data-action="removeAvatar" style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Remove') + '</span>'
        + '</div>'
        + '<div style="padding:0 10px 8px 10px; display:flex; flex-direction:column; gap:6px;">'
          +   '<label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Display name') + '</label>'
          +   '<div style="display:flex; gap:6px;">'
          +     '<input id="displayNameInput" data-field="displayNameDraft" value="' + esc(state.displayNameDraft) + '" maxlength="60" style="flex:1; min-width:0; height:32px; padding:0 8px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:13px; background:' + c.surface + '; color:' + c.onSurface + ';"></input>'
          +     '<div class="interactive" data-action="saveDisplayName" style="display:flex; align-items:center; justify-content:center; padding:0 10px; border-radius:var(--r-sm); background:' + c.primary + '; color:' + c.onPrimary + '; font-size:12px; font-weight:600;">' + T('Save') + '</div>'
          +   '</div>'
        + '</div>'
        + '<div style="height:1px; background:' + c.outlineVariant + '; margin:2px 0;"></div>'
        + (state.user.role === 'admin'
          ? '<div style="padding:6px 10px 8px 10px; display:flex; flex-direction:column; gap:6px;">'
            + '<label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('App name') + '</label>'
            + '<div style="display:flex; gap:6px;">'
            +   '<input id="appNameInput" data-field="appNameDraft" value="' + esc(state.appNameDraft) + '" maxlength="60" style="flex:1; min-width:0; height:32px; padding:0 8px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:13px; background:' + c.surface + '; color:' + c.onSurface + ';"></input>'
            +   '<div class="interactive" data-action="saveAppName" style="display:flex; align-items:center; justify-content:center; padding:0 10px; border-radius:var(--r-sm); background:' + c.primary + '; color:' + c.onPrimary + '; font-size:12px; font-weight:600;">' + T('Save') + '</div>'
            + '</div>'
            + '</div>'
            + '<div style="height:1px; background:' + c.outlineVariant + '; margin:2px 0;"></div>'
          : '')
        + '<div class="appearance-in-menu" style="flex-direction:column; gap:8px; padding:6px 10px 10px 10px;">'
        +   '<label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Appearance') + '</label>'
        +   '<div style="display:flex; align-items:center; gap:10px;">'
        +     accentControls(c)
        +     '<span class="interactive" data-action="cycleThemeMode" title="' + T(state.themeMode === 'light' ? 'Theme: Light' : state.themeMode === 'dark' ? 'Theme: Dark' : 'Theme: System') + '" style="margin-left:auto; display:flex; align-items:center; justify-content:center; width:30px; height:30px; border-radius:50%; background:' + c.surfaceContainerHigh + '; color:' + c.onSurfaceVariant + ';">'
        +       (state.themeMode === 'light' ? ICON.themeLight : state.themeMode === 'dark' ? ICON.themeDark : ICON.themeSystem)
        +     '</span>'
        +   '</div>'
        + '</div>'
        + '<div class="appearance-in-menu" style="height:1px; background:' + c.outlineVariant + '; margin:2px 0;"></div>'
        + (isAdmin()
          ? '<div class="interactive" data-action="openUsers" style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:9px 10px; border-radius:var(--r-sm); font-size:13px; color:' + c.onSurface + ';"><span>' + T('Accounts') + '</span>'
            + (pendingUserCount() > 0 ? '<span style="font-size:12px; font-weight:600; padding:1px 7px; border-radius:var(--r-sm); background:' + c.error + '; color:#fff;">' + pendingUserCount() + '</span>' : '')
            + '</div>'
          : '')
        + '<div class="interactive" data-action="openPasswordModal" style="padding:9px 10px; border-radius:var(--r-sm); font-size:13px; color:' + c.onSurface + ';">' + T('Change password') + '</div>'
        + '<div class="interactive" data-action="openAppPasswords" style="padding:9px 10px; border-radius:var(--r-sm); font-size:13px; color:' + c.onSurface + ';">' + T('Phone sync') + '</div>'
        + (isAdmin() ? '<div class="interactive" data-action="openReminders" style="padding:9px 10px; border-radius:var(--r-sm); font-size:13px; color:' + c.onSurface + ';">' + T('Due-date reminders') + '</div>' : '')
        + (isAdmin() ? '<div class="interactive" data-action="openBackups" style="padding:9px 10px; border-radius:var(--r-sm); font-size:13px; color:' + c.onSurface + ';">' + T('Backups') + '</div>' : '')
        + '<div class="interactive" data-action="openGuide" style="padding:9px 10px; border-radius:var(--r-sm); font-size:13px; color:' + c.onSurface + ';">' + T('Guide') + '</div>'
        + '<div class="interactive" data-action="logout" style="padding:9px 10px; border-radius:var(--r-sm); font-size:13px; color:' + c.error + ';">' + T('Log out') + '</div>'
        + '</div>'
      : '';

    return '<header class="top-bar" style="flex-shrink:0; display:flex; align-items:center; gap:16px; background:' + c.surface + '; border-bottom:1px solid ' + c.outlineVariant + ';">'
      + '<div class="interactive hamburger-btn" data-action="toggleSidebar" title="' + T('Departments') + '" style="align-items:center; justify-content:center; width:36px; height:36px; border-radius:50%; color:' + c.onSurfaceVariant + '; flex-shrink:0;">' + ICON.hamburger + '</div>'
      + '<div style="display:flex; align-items:center; gap:10px;">'
      +   (state.user.role === 'admin'
            ? '<div data-dropdown="brand" style="position:relative; display:flex;">' + brandIconHtml(c.primaryContainer, c.onPrimaryContainer, 36, 'edit') + brandMenu(c) + '</div>'
            : brandIconHtml(c.primaryContainer, c.onPrimaryContainer, 36, 'guide'))
      +   '<div class="app-name-text" style="font-size:18px; font-weight:500; white-space:nowrap;">' + esc(state.appName) + '</div>'
      + '</div>'
      + '<div class="topbar-center" style="flex:1; display:flex; justify-content:center;">'
      +   '<div class="desktop-search-bar" style="align-items:center; gap:8px; width:420px; max-width:100%; height:40px; padding:0 14px; border-radius:var(--r-sm); background:' + c.surfaceContainerHigh + '; color:' + c.onSurfaceVariant + ';">'
      +     ICON.search
      +     '<input id="searchInput" data-field="searchQuery" value="' + esc(state.searchQuery) + '" placeholder="' + T('Search tasks, comments, files') + '" style="border:none; outline:none; background:transparent; flex:1; font-size:14px; color:inherit;"></input>'
      +     searchClear
      +   '</div>'
      +   '<div class="interactive mobile-search-btn" data-action="openMobileSearch" title="' + T('Search') + '" style="align-items:center; justify-content:center; width:36px; height:36px; border-radius:50%; color:' + c.onSurfaceVariant + ';">' + ICON.search + '</div>'
      + '</div>'
      + '<div class="appearance-controls" style="display:flex; align-items:center; gap:10px;">'
      +   '<div data-dropdown="accent" style="position:relative; width:36px; height:36px;">'
      +     (state.accentPickerPhase === 'closed'
            ? '<div class="interactive" data-action="toggleAccentPicker" title="' + T('Accent color') + '" style="width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; background:' + c.surfaceContainerHigh + '; color:' + c.onSurfaceVariant + ';">' + ICON.eyedropper + '</div>'
            : '<div class="accent-pill ' + accentMotion().cls + '" style="' + accentMotion().style + 'position:absolute; top:0; right:0; height:36px; display:flex; align-items:center; gap:8px; padding:0 8px; border-radius:var(--r-sm); background:' + c.surfaceContainerHigh + '; box-shadow:var(--e2); z-index:70; overflow:hidden;">'
              +   accentControls(c)
              + '</div>')
      +   '</div>'
      +   '<div class="interactive" data-action="cycleThemeMode" title="' + T(state.themeMode === 'light' ? 'Theme: Light' : state.themeMode === 'dark' ? 'Theme: Dark' : 'Theme: System') + '" style="width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; background:' + c.surfaceContainerHigh + '; color:' + c.onSurfaceVariant + ';">'
      +     '<span class="' + oneShotClass('themeIcon').trim() + '" style="display:flex; align-items:center; justify-content:center;">'
      +       (state.themeMode === 'light' ? ICON.themeLight : state.themeMode === 'dark' ? ICON.themeDark : ICON.themeSystem)
      +     '</span>'
      +   '</div>'
      + '</div>'
      + '<div class="topbar-divider" style="width:1px; height:26px; background:' + c.outlineVariant + ';"></div>'
      + '<div style="display:flex; align-items:center; gap:14px;">'
      +   '<div data-dropdown="notif" style="position:relative;">'
      +     '<div class="interactive" data-action="toggleNotif" title="' + T('Notifications') + '" style="position:relative; width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:' + c.onSurfaceVariant + ';">'
      +       '<svg width="21" height="21" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8a5 5 0 0 1 10 0c0 4 1.5 5 1.5 5h-13S5 12 5 8Z"></path><path d="M8.3 16a1.8 1.8 0 0 0 3.4 0"></path></svg>'
      +       (bellCount > 0
                ? '<span aria-label="' + T('{n} unread', { n: bellCount }) + '" style="position:absolute; top:2px; right:1px; min-width:17px; height:17px; padding:0 4px; border-radius:9px; background:' + c.error + '; color:#fff; font-size:12px; font-weight:600; display:flex; align-items:center; justify-content:center; border:1.5px solid ' + c.surface + ';">' + (bellCount > 99 ? '99+' : bellCount) + '</span>'
                : (unread > 0 ? '<span style="position:absolute; top:6px; right:7px; width:7px; height:7px; border-radius:50%; background:' + c.outline + '; border:1.5px solid ' + c.surface + ';"></span>' : ''))
      +     '</div>'
      +     notifPanel
      +   '</div>'
      +   '<div class="interactive calendar-drawer-btn" data-action="toggleMobileCalendar" title="' + T('Calendar') + '" style="align-items:center; justify-content:center; width:36px; height:36px; border-radius:50%; color:' + c.onSurfaceVariant + ';">' + ICON.calendarView + '</div>'
      +   '<div data-dropdown="account" style="position:relative;">'
      +     '<div class="interactive" data-action="toggleAccount" style="display:flex; align-items:center; gap:9px; border-radius:var(--r-sm); padding:4px 8px 4px 4px;">'
      +       avatarHtml(avatarColors(state.user.displayName, c.dark).bg, avatarColors(state.user.displayName, c.dark).color, 34)
      +       '<div class="account-meta" style="line-height:1.25;"><div style="font-size:13px; font-weight:500;">' + esc(state.user.displayName) + '</div><div style="font-size:12px; color:' + c.onSurfaceVariant + ';">' + esc(T(state.user.role)) + '</div></div>'
      +       '<svg class="account-meta" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" style="color:' + c.onSurfaceVariant + ';"><path d="M6 8l4 4 4-4"></path></svg>'
      +     '</div>'
      +     accountPanel
      +   '</div>'
      + '</div>'
      + '</header>';
  }

  // The resting 'open' class and the one-shot 'anim-open'/'anim-close' class
  // are independent: 'open' is the settled position (also what CSS falls
  // back to on desktop, where none of this matters), the anim class is only
  // present for the duration of a slide and self-clears - see the mobile
  // drawer functions above.
  function drawerClass(base, open, anim) {
    return base + (open ? ' open' : '') + (anim ? ' ' + anim : '');
  }

  function leftNav(c) {
    var allSelected = state.selectedNode === 'all';
    var mineSelected = state.selectedNode === 'mine';
    var allCount = state.summary.all;
    var tree = buildDeptTree();

    var deptsHtml = tree.map(function (d) {
      var expanded = !!state.expanded[d.id];
      var anim = state.expandAnim[d.id];
      var selected = state.selectedNode === d.id;
      var deptCount = state.summary.byDept[d.id] || 0;
      var childrenHtml = d.children.map(function (child) {
        var childSelected = state.selectedNode === child.id;
        var childCount = state.summary.byDept[child.id] || 0;
        return '<div class="interactive' + (childSelected ? oneShotClass('node') : '') + '" data-action="selectNode" data-id="' + esc(child.id) + '"' + (childSelected ? ' aria-current="true"' : '') + ' style="display:flex; align-items:center; padding:7px 10px; font-size:13px; font-weight:' + (childSelected ? 600 : 400) + '; border-radius:var(--r-sm); background:' + (childSelected ? c.primaryContainer : 'transparent') + '; color:' + (childSelected ? c.onPrimaryContainer : c.onSurfaceVariant) + ';">'
          + '<span style="flex:1;">' + esc(child.name) + '</span>'
          + '<span style="font-size:12px; padding:1px 7px; border-radius:var(--r-sm); background:' + (childSelected ? c.primary : c.surfaceContainerHigh) + '; color:' + (childSelected ? c.onPrimary : c.onSurfaceVariant) + ';">' + childCount + '</span>'
          + '</div>';
      }).join('');

      return '<div class="' + (selected ? oneShotClass('node').trim() : '') + '" style="display:flex; align-items:center; gap:6px; padding:9px 10px; border-radius:var(--r-sm); background:' + (selected ? c.surfaceContainerHigh : 'transparent') + '; margin-top:6px;">'
        + '<svg class="interactive tree-chevron' + (expanded ? ' expanded' : '') + (anim ? ' ' + anim : '') + '" data-action="toggleExpand" data-id="' + esc(d.id) + '" role="button" aria-expanded="' + (expanded ? 'true' : 'false') + '" aria-controls="subtree-' + esc(d.id) + '" aria-label="' + (expanded ? 'Collapse ' : 'Expand ') + esc(d.name) + '" width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 5l6 5-6 5"></path></svg>'
        + '<span class="interactive" data-action="selectNode" data-id="' + esc(d.id) + '" style="display:flex; align-items:center; gap:6px; flex:1; min-width:0; border-radius:var(--r-sm);">'
        +   '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M3 6a1 1 0 0 1 1-1h4l1.5 2H16a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6Z"></path></svg>'
        +   '<span style="font-size:14px; font-weight:' + (selected ? 600 : 400) + ';">' + esc(d.name) + '</span>'
        + '</span>'
        + '<span style="font-size:12px; padding:1px 7px; border-radius:var(--r-sm); background:' + c.surfaceContainerHigh + '; color:' + c.onSurfaceVariant + ';">' + deptCount + '</span>'
        + (isAdmin() ? '<span class="interactive" data-action="openMapping" data-id="' + esc(d.id) + '" title="' + T('Department settings') + '" style="display:flex; align-items:center; justify-content:center; width:20px; height:20px; border-radius:var(--r-sm); flex-shrink:0; color:' + c.onSurfaceVariant + ';">' + ICON.more + '</span>' : '')
        + '</div>'
        + '<div class="tree-children' + (expanded ? ' expanded' : '') + (anim ? ' ' + anim : '') + '" id="subtree-' + esc(d.id) + '" style="padding-left:34px;">'
        +   '<div class="tree-children-inner" role="group" aria-label="' + esc(T('{name} sub-departments', { name: d.name })) + '">' + childrenHtml + '</div>'
        + '</div>';
    }).join('');

    // Closed, the drawer is off screen and out of the reading order; it is
    // still rendered so it can slide in and out.
    var hidden = !state.mobileNavOpen && state.mobileNavAnim !== 'anim-close';
    return '<nav class="no-scrollbar ' + drawerClass('left-nav', state.mobileNavOpen, state.mobileNavAnim) + '" aria-label="' + T('Departments') + '" aria-hidden="' + (hidden ? 'true' : 'false') + '"' + (hidden ? ' inert' : '') + ' data-scroll-key="sidebar" style="min-height:0; background:' + c.surfaceContainerLow + '; overflow-y:auto; overflow-x:hidden; padding:18px 12px; display:flex; flex-direction:column; gap:2px;">'
      + '<div style="display:flex; align-items:center; justify-content:space-between; padding:0 8px 10px 8px;">'
      +   '<span style="font-size:12px; font-weight:600; letter-spacing:.04em; color:' + c.onSurfaceVariant + ';">' + T('DEPARTMENTS') + '</span>'
      +   '<span class="interactive drawer-close-btn" data-action="closeMobileNav" title="' + T('Close') + '" style="align-items:center; justify-content:center; width:26px; height:26px; border-radius:var(--r-sm); color:' + c.onSurfaceVariant + ';">' + ICON.close + '</span>'
      + '</div>'
      + '<div class="interactive' + (allSelected ? oneShotClass('node') : '') + '" data-action="selectNode" data-id="all" style="display:flex; align-items:center; gap:9px; padding:9px 10px; border-radius:var(--r-sm); background:' + (allSelected ? c.surfaceContainerHigh : 'transparent') + '; color:' + c.onSurfaceVariant + ';">'
      +   '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8l1-4h10l1 4"></path><path d="M3 8h14v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8Z"></path><path d="M8 11h4"></path></svg>'
      +   '<span style="flex:1; font-size:14px;">' + T('All Tasks') + '</span>'
      +   '<span style="font-size:12px; padding:1px 7px; border-radius:var(--r-sm); background:' + c.surfaceContainerHigh + '; color:' + c.onSurfaceVariant + ';">' + allCount + '</span>'
      + '</div>'
      + '<div class="interactive' + (mineSelected ? oneShotClass('node') : '') + '" data-action="selectNode" data-id="mine" style="display:flex; align-items:center; gap:9px; padding:9px 10px; border-radius:var(--r-sm); background:' + (mineSelected ? c.surfaceContainerHigh : 'transparent') + '; color:' + c.onSurfaceVariant + ';">'
      +   '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="7" r="3"></circle><path d="M4 16a6 6 0 0 1 12 0"></path></svg>'
      +   '<span style="flex:1; font-size:14px; font-weight:' + (mineSelected ? 600 : 400) + ';">' + T('My Tasks') + '</span>'
      +   '<span style="font-size:12px; padding:1px 7px; border-radius:var(--r-sm); background:' + c.surfaceContainerHigh + '; color:' + c.onSurfaceVariant + ';">' + state.summary.mine + '</span>'
      + '</div>'
      + deptsHtml
      + '<div style="flex:1;"></div>'
      + '<div class="interactive" data-action="openTrash" style="display:flex; align-items:center; gap:9px; padding:9px 10px; margin-top:10px; border-radius:var(--r-sm); color:' + c.onSurfaceVariant + ';">'
      +   ICON.trash
      +   '<span style="flex:1; font-size:14px;">' + T('Trash') + '</span>'
      +   (state.summary.trash ? '<span style="font-size:12px; padding:1px 7px; border-radius:var(--r-sm); background:' + c.surfaceContainerHigh + '; color:' + c.onSurfaceVariant + ';">' + state.summary.trash + '</span>' : '')
      + '</div>'
      + (isAdmin()
        ? '<div class="interactive" data-action="openAddDept" style="display:flex; align-items:center; gap:8px; padding:9px 10px; margin-top:10px; border-radius:var(--r-sm); border:1.5px dashed ' + c.outline + '; color:' + c.primary + '; font-size:13px; font-weight:500;">'
          + ICON.plus + '<span>' + T('Add Department') + '</span>'
        + '</div>'
        : '')
      + '</nav>';
  }

  function mainContent(c) {
    var meta = state.taskMeta;
    var searching = state.searchQuery.trim().length > 0;
    var fixedScope = state.selectedNode === 'all' || state.selectedNode === 'mine';
    var pathLabel = searching || fixedScope ? '' : nodeLabel(state.selectedNode).replace(' · ', ' › ');
    var titleLabel = searching
      ? T('Search results for “{q}”', { q: state.searchQuery.trim() })
      : (fixedScope ? nodeLabel(state.selectedNode) : T('{name} Tasks', { name: nodeLabel(state.selectedNode).split(' · ').pop() }));

    var tabsHtml = TAB_ORDER.map(function (id) {
      var count = statusCount(id);
      var active = state.activeTab === id;
      var bg = active ? c.primaryContainer : 'transparent';
      var color = active ? c.onPrimaryContainer : (id === 'overdue' ? c.error : c.onSurfaceVariant);
      return '<div class="interactive' + (active ? oneShotClass('tab') : '') + '" data-action="setTab" data-id="' + id + '" role="tab" aria-selected="' + (active ? 'true' : 'false') + '" aria-label="' + TAB_LABELS[id] + ', ' + T(count === 1 ? '{n} task' : '{n} tasks', { n: count }) + '" style="display:flex; align-items:center; gap:6px; padding:8px 16px; border-radius:var(--r-sm); background:' + bg + '; color:' + color + '; font-size:13px; font-weight:' + (active ? 600 : 500) + ';">'
        + '<span>' + TAB_LABELS[id] + '</span><span style="opacity:.75;">' + count + '</span></div>';
    }).join('');

    var maps = styleMaps(c);
    var totalPages = Math.max(1, meta.totalPages || 1);
    var page = clamp(meta.page || 1, 1, totalPages);
    var pageItems = state.tasks;

    var filterField = 'height:36px; padding:0 10px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:13px; background:' + c.surface + '; color:' + c.onSurface + ';';
    var filterPanel = (state.filterOpen || state.dropdownClosing === 'filter')
      ? '<div class="' + dropdownClass('filter') + '" style="' + dropdownStyle('filter') + 'position:absolute; top:46px; right:0; width:240px; background:' + c.surface + '; border:1px solid ' + c.outlineVariant + '; border-radius:var(--r-md); box-shadow:var(--e2); padding:14px; z-index:60; display:flex; flex-direction:column; gap:12px;">'
        + '<div><div style="font-size:12px; font-weight:600; letter-spacing:.03em; color:' + c.onSurfaceVariant + '; margin-bottom:6px;">' + T('SORT BY') + '</div>'
        +   mSelectFrom('<select id="filterSortSelect" aria-label="' + T('Sort by') + '" style="' + filterField + '">'
              + TASK_SORTS.map(function (o) { return '<option value="' + o[0] + '"' + (state.taskSort === o[0] ? ' selected' : '') + '>' + T(o[1]) + '</option>'; }).join('')
              + '</select>', c)
        + '</div>'
        + '<div><div style="font-size:12px; font-weight:600; letter-spacing:.03em; color:' + c.onSurfaceVariant + '; margin-bottom:6px;">' + T('ASSIGNEE') + '</div>'
        +   mSelectFrom('<select id="filterAssigneeSelect" aria-label="' + T('Assignee') + '" style="' + filterField + '">'
              + [['', T('Anyone')], ['none', T('Unassigned')]].concat(state.members.map(function (m) { return [String(m.id), esc(m.displayName)]; }))
                  .map(function (o) { return '<option value="' + o[0] + '"' + (state.filterAssignee === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('')
              + '</select>', c)
        + '</div>'
        + '<div><div style="font-size:12px; font-weight:600; letter-spacing:.03em; color:' + c.onSurfaceVariant + '; margin-bottom:6px;">' + T('PRIORITY') + '</div>'
        + ['High', 'Medium', 'Low'].map(function (p) {
            return '<label class="interactive" style="display:flex; align-items:center; gap:8px; padding:5px 4px; border-radius:var(--r-sm); font-size:13px; cursor:pointer;"><input type="checkbox" data-action="toggleFilterPriority" data-id="' + p + '" ' + (state.filterPriority[p] ? 'checked' : '') + '></input>' + T(p) + '</label>';
          }).join('')
        + '</div>'
        + '<div><div style="font-size:12px; font-weight:600; letter-spacing:.03em; color:' + c.onSurfaceVariant + '; margin-bottom:6px;">' + T('CALENDAR') + '</div>'
        + [['all', 'All'], ['shown', 'In calendar'], ['hidden', 'Not in calendar']].map(function (pair) {
            return '<label class="interactive" style="display:flex; align-items:center; gap:8px; padding:5px 4px; border-radius:var(--r-sm); font-size:13px; cursor:pointer;"><input type="radio" name="filterCalendar" data-action="setFilterCalendar" data-id="' + pair[0] + '" ' + (state.filterCalendar === pair[0] ? 'checked' : '') + '></input>' + T(pair[1]) + '</label>';
          }).join('')
        + '</div>'
        + (filtersActive() ? '<span class="interactive" data-action="clearFilters" style="align-self:flex-end; font-size:12px; font-weight:600; color:' + c.primary + ';">' + T('Clear filters') + '</span>' : '')
        + '</div>'
      : '';

    var bodyHtml;
    if (state.viewMode === 'grid' || isNarrowScreen()) {
      var cardsHtml = pageItems.map(function (t) { return taskCard(t, maps, c); }).join('');
      var gridEmpty = pageItems.length === 0
        ? '<div style="grid-column:1/-1; padding:40px 16px; text-align:center; font-size:13px; color:' + c.onSurfaceVariant + ';">' + T('No tasks match.') + '</div>' : '';
      bodyHtml = '<div data-scroll-key="' + esc(listScrollKey()) + '" style="flex:1; min-height:0; overflow:auto;"><div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:12px; padding:2px;">' + cardsHtml + gridEmpty + '</div></div>';
    } else {
      var rowsHtml = pageItems.map(function (t) { return taskRow(t, maps, c); }).join('');
      var emptyHtml = pageItems.length === 0
        ? '<div style="grid-column:1 / -1; padding:40px 16px; text-align:center; font-size:13px; color:' + c.onSurfaceVariant + ';">' + T('No tasks match.') + '</div>' : '';
      bodyHtml = '<div data-scroll-key="' + esc(listScrollKey()) + '" style="flex:1; min-height:0; overflow:auto; border:1px solid ' + c.outlineVariant + '; border-radius:var(--r-md); background:' + c.surface + ';">'
        + '<div style="display:grid; grid-template-columns:132px minmax(220px,1fr) 168px 104px 104px 88px; min-width:820px;">'
        +   [T('Status'), T('Task'), T('Assignee'), T('Priority'), T('Due Date'), T('Calendar')].map(function (h) {
              return '<div style="position:sticky; top:0; background:' + c.surfaceContainerLow + '; font-size:12px; font-weight:600; color:' + c.onSurfaceVariant + '; padding:12px 16px; border-bottom:2px solid ' + c.outlineVariant + ';">' + h + '</div>';
            }).join('')
        +   rowsHtml + emptyHtml
        + '</div></div>';
    }

    var rangeStart = pageItems.length === 0 ? 0 : (page - 1) * meta.pageSize + 1;
    var rangeEnd = (page - 1) * meta.pageSize + pageItems.length;
    var animClass = state.contentAnim === 'out' ? 'content-out' : (state.contentAnim === 'in' ? 'content-in' : '');

    return '<main id="task-list" tabindex="-1" class="' + animClass + '" style="flex:1; min-width:0; display:flex; flex-direction:column; overflow:hidden; padding:22px 26px; gap:14px;">'
      + '<div style="display:flex; align-items:flex-start; justify-content:space-between; gap:16px;">'
      +   '<div style="min-width:0; flex:1;"><div style="font-size:12px; color:' + c.onSurfaceVariant + '; margin-bottom:3px;">' + esc(pathLabel) + '</div><div class="page-title" title="' + esc(titleLabel) + '" style="font-size:24px; font-weight:600;">' + esc(titleLabel) + '</div></div>'
      +   '<div style="display:flex; align-items:center; gap:8px;">'
      +     '<div class="view-toggle" style="position:relative; display:flex; align-items:center; gap:2px; padding:3px; border-radius:var(--r-sm); background:' + c.surfaceContainerHigh + ';">'
      +       '<div class="view-toggle-thumb' + (state.viewToggleAnim ? ' ' + state.viewToggleAnim : '') + '" style="background:' + c.surface + '; box-shadow:var(--e1); transform:translateX(' + (state.viewMode === 'grid' ? 32 : 0) + 'px);"></div>'
      +       '<div class="interactive" data-action="setViewMode" data-id="list" style="position:relative; z-index:1; width:30px; height:30px; border-radius:var(--r-sm); display:flex; align-items:center; justify-content:center; color:' + (state.viewMode === 'list' ? c.onSurface : c.onSurfaceVariant) + ';">' + ICON.listView + '</div>'
      +       '<div class="interactive" data-action="setViewMode" data-id="grid" style="position:relative; z-index:1; width:30px; height:30px; border-radius:var(--r-sm); display:flex; align-items:center; justify-content:center; color:' + (state.viewMode === 'grid' ? c.onSurface : c.onSurfaceVariant) + ';">' + ICON.gridView + '</div>'
      +     '</div>'
      +     '<div data-dropdown="filter" style="position:relative;">'
      +       '<div class="interactive filter-btn" data-action="toggleFilterOpen" title="' + T('Filter') + '" style="position:relative; display:flex; align-items:center; gap:6px; height:40px; padding:0 16px; border-radius:var(--r-sm); border:1px solid ' + (filtersActive() ? c.primary : c.outline) + '; color:' + (filtersActive() ? c.primary : c.onSurfaceVariant) + '; font-size:14px; font-weight:500;">' + ICON.filter + '<span class="btn-label">' + T('Filter') + '</span>'
      +         (filtersActive() ? '<span aria-label="' + T('Filters on') + '" style="position:absolute; top:6px; right:8px; width:7px; height:7px; border-radius:50%; background:' + c.primary + ';"></span>' : '') + '</div>'
      +       filterPanel
      +     '</div>'
      +     (canCreateTask()
              ? '<div class="interactive new-task-inline" data-action="openTaskModal" style="display:flex; align-items:center; gap:7px; height:40px; padding:0 18px; border-radius:var(--r-sm); background:' + c.primary + '; color:' + c.onPrimary + '; font-size:14px; font-weight:600;">' + ICON.plus + '<span>' + T('New Task') + '</span></div>'
              : '<div class="new-task-inline" title="' + T('An administrator has to put your account in a department first') + '" style="display:flex; align-items:center; gap:7px; height:40px; padding:0 18px; border-radius:var(--r-sm); background:' + c.surfaceContainerHigh + '; color:' + c.onSurfaceVariant + '; font-size:14px; font-weight:600; opacity:.7;">' + ICON.plus + '<span>' + T('New Task') + '</span></div>')
      +   '</div>'
      + '</div>'
      + '<div role="tablist" aria-label="' + T('Filter by status') + '" data-scroll-key="tabs" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">' + tabsHtml + '</div>'
      + bodyHtml
      + '<div style="flex-shrink:0; display:flex; align-items:center; justify-content:space-between; font-size:13px; color:' + c.onSurfaceVariant + ';">'
      +   '<span aria-live="polite">' + T('Showing {a}-{b} of {n}', { a: rangeStart, b: rangeEnd, n: meta.total }) + '</span>'
      +   '<div style="display:flex; align-items:center; gap:14px;"><span>' + T('Page {p} of {n}', { p: page, n: totalPages }) + '</span>'
      +     '<div style="display:flex; align-items:center; gap:4px;">'
      +       '<div class="interactive" data-action="prevPage" aria-label="' + T('Previous page') + '" aria-disabled="' + (page <= 1 ? 'true' : 'false') + '" style="width:28px; height:28px; border-radius:var(--r-sm); display:flex; align-items:center; justify-content:center; color:' + c.onSurfaceVariant + '; opacity:' + (page <= 1 ? '.4' : '1') + '; pointer-events:' + (page <= 1 ? 'none' : 'auto') + ';">' + ICON.chevronLeft + '</div>'
      +       '<div class="interactive" data-action="nextPage" aria-label="' + T('Next page') + '" aria-disabled="' + (page >= totalPages ? 'true' : 'false') + '" style="width:28px; height:28px; border-radius:var(--r-sm); display:flex; align-items:center; justify-content:center; color:' + c.onSurfaceVariant + '; opacity:' + (page >= totalPages ? '.4' : '1') + '; pointer-events:' + (page >= totalPages ? 'none' : 'auto') + ';">' + ICON.chevronRight + '</div>'
      +     '</div>'
      +   '</div>'
      + '</div>'
      + '</main>';
  }

  function miniCalendar(c) {
    var today = new Date();
    var year = today.getFullYear(), month = today.getMonth(), todayDate = today.getDate();
    var firstWeekday = new Date(year, month, 1).getDay();
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var dayCells = [];
    for (var i = 0; i < firstWeekday; i++) dayCells.push('<div></div>');
    for (var d = 1; d <= daysInMonth; d++) {
      if (d === todayDate) {
        dayCells.push('<div style="display:flex; align-items:center; justify-content:center;"><span style="display:flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; background:' + c.primary + '; color:' + c.onPrimary + '; font-size:12px; font-weight:600;">' + d + '</span></div>');
      } else {
        dayCells.push('<div style="display:flex; align-items:center; justify-content:center; font-size:12px;">' + d + '</div>');
      }
    }
    var trailing = (7 - (dayCells.length % 7)) % 7;
    for (var j = 0; j < trailing; j++) dayCells.push('<div></div>');
    return '<div><div style="font-size:13px; font-weight:600; margin-bottom:8px;">' + esc(new Date(year, month, 1).toLocaleDateString(LOCALE, { year: 'numeric', month: 'long' })) + '</div>'
      + '<div style="display:grid; grid-template-columns:repeat(7,1fr); gap:4px; font-size:12px; color:' + c.onSurfaceVariant + '; text-align:center; margin-bottom:4px;">'
      + (LANG === 'ko' ? ['일', '월', '화', '수', '목', '금', '토'] : ['S', 'M', 'T', 'W', 'T', 'F', 'S']).map(function (x) { return '<div>' + x + '</div>'; }).join('')
      + '</div>'
      + '<div style="display:grid; grid-template-columns:repeat(7,1fr); grid-auto-rows:26px; gap:4px; text-align:center;">' + dayCells.join('') + '</div>'
      + '</div>';
  }

  function rightPanel(c) {
    // Due today: unfinished work due today or already late, from the tasks
    // themselves. Ticking the box completes the task; the title opens it.
    var todayHtml = state.todayTasks.map(function (t) {
      var done = t.status === 'done';
      var boxBg = done ? c.secondary : 'transparent';
      var boxBorder = done ? c.secondary : (t.overdue ? c.error : c.outline);
      var textColor = done ? c.onSurfaceVariant : c.onSurface;
      var check = done ? '<svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="' + c.onSecondary + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 10l3.5 3.5L15 6.5"></path></svg>' : '';
      var tickable = canWriteDept(t.deptId);
      var when = t.overdue
        ? '<span style="font-size:12px; font-weight:600; color:' + c.error + ';">' + T('Overdue') + ' &middot; ' + esc(formatDue(t.dueDate)) + '</span>'
        : '<span style="font-size:12px; font-weight:600; color:' + c.onSurfaceVariant + ';">' + T('Today') + '</span>';
      return '<div class="' + oneShotClass('todayLeave:' + t.id).trim() + '" style="display:flex; align-items:flex-start; gap:9px; border-radius:var(--r-sm);">'
        +   (tickable
              ? '<div class="interactive' + oneShotClass('today:' + t.id) + '" data-action="toggleTodayTask" data-id="' + t.id + '" title="' + T(done ? 'Mark not done' : 'Mark done') + '" style="width:16px; height:16px; margin-top:1px; border-radius:var(--r-xs); background:' + boxBg + '; border:1.6px solid ' + boxBorder + '; display:flex; align-items:center; justify-content:center; flex-shrink:0;">' + check + '</div>'
              : '<div style="width:16px; height:16px; margin-top:1px; border-radius:var(--r-xs); border:1.6px solid ' + c.outlineVariant + '; flex-shrink:0; opacity:.5;"></div>')
        +   '<div class="interactive" data-action="openTask" data-id="' + t.id + '" style="flex:1; min-width:0;">'
        +     '<div style="display:flex; align-items:center; gap:5px; font-size:13px; color:' + textColor + '; text-decoration:' + (done ? 'line-through' : 'none') + ';">' + taskIconHtml(t, 14) + '<span>' + esc(t.title) + '</span></div>'
        +     '<div style="display:flex; align-items:center; gap:6px; margin-top:3px; flex-wrap:wrap;">' + when
        +       (t.deptId ? '<span style="font-size:12px; font-weight:600; color:' + c.onSurfaceVariant + '; background:' + c.surfaceVariant + '; padding:1px 8px; border-radius:var(--r-sm);">' + esc(nodeLabel(t.deptId)) + '</span>' : '')
        +     '</div>'
        +   '</div>'
        + '</div>';
    }).join('');
    var todayEmpty = state.todayTasks.length === 0
      ? '<div style="font-size:13px; color:' + c.onSurfaceVariant + ';">' + T('Nothing due today.') + '</div>' : '';

    var mappingDots = [c.primary, c.tertiary, c.secondary, c.error, c.outline];
    var flatOpts = flattenDeptOptions();
    var mappingRows = flatOpts.map(function (opt, i) {
      var d = findDept(opt.id);
      var url = location.origin + '/calendar/' + d.feedToken + '.ics';
      var labelLine = (d.calendarList || d.tag)
        ? (esc(d.calendarList) + (d.tag ? ' · ' + esc(d.tag) : ''))
        : (isAdmin()
            ? '<span class="interactive" data-action="openMapping" data-id="' + esc(d.id) + '" style="text-decoration:underline; cursor:pointer;">' + T('Add a label') + '</span>'
            : 'No label');
      return '<div style="display:flex; align-items:flex-start; gap:9px;">'
        + '<span style="width:9px; height:9px; margin-top:4px; border-radius:50%; background:' + mappingDots[i % mappingDots.length] + '; flex-shrink:0;"></span>'
        + '<div style="flex:1; min-width:0;">'
        +   '<div style="font-size:13px; font-weight:500;">' + esc(opt.label) + '</div>'
        +   '<div style="font-size:12px; color:' + c.onSurfaceVariant + '; margin-top:1px;">' + labelLine + '</div>'
        +   '<div style="display:flex; align-items:center; gap:5px; margin-top:3px;"><code style="font-size:12px; color:' + c.onSurfaceVariant + '; background:' + c.surfaceVariant + '; padding:2px 6px; border-radius:var(--r-sm); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px;">' + esc(url) + '</code>'
        +     '<span class="interactive" data-action="copyFeedUrl" data-id="' + esc(d.feedToken) + '" title="' + T('Copy subscribe link') + '" style="display:flex; align-items:center; justify-content:center; width:20px; height:20px; border-radius:var(--r-sm); color:' + (state.copiedToken === d.feedToken ? c.secondary : c.onSurfaceVariant) + ';">' + (state.copiedToken === d.feedToken ? '<span class="anim-copied" style="display:flex;">' + ICON.check + '</span>' : ICON.copy) + '</span></div>'
        + '</div></div>';
    }).join('');
    var mappingEmpty = flatOpts.length === 0
      ? '<div style="font-size:13px; color:' + c.onSurfaceVariant + ';">' + T('No departments yet — add one to get a subscribable calendar link.') + '</div>' : '';

    return '<div class="' + drawerClass('right-panel', state.mobileCalendarOpen, state.mobileCalendarAnim) + '" data-scroll-key="schedule" style="width:320px; flex-shrink:0; min-height:0; background:' + c.surfaceContainerLow + '; border-left:1px solid ' + c.outlineVariant + '; overflow-y:auto; padding:20px 16px; display:flex; flex-direction:column; gap:16px;">'
      + '<div class="drawer-header-row" style="align-items:center; justify-content:space-between;">'
      +   '<span style="font-size:15px; font-weight:600;">' + T('Schedule') + '</span>'
      +   '<span class="interactive drawer-close-btn" data-action="closeMobileCalendar" title="' + T('Close') + '" style="align-items:center; justify-content:center; width:26px; height:26px; border-radius:var(--r-sm); color:' + c.onSurfaceVariant + ';">' + ICON.close + '</span>'
      + '</div>'
      + '<div style="background:' + c.surface + '; border:1px solid ' + c.outlineVariant + '; border-radius:var(--r-md); padding:16px; display:flex; flex-direction:column; gap:12px;">'
      +   '<span style="font-size:14px; font-weight:600;">' + T('Calendar') + '</span>'
      +   miniCalendar(c)
      + '</div>'
      + '<div style="background:' + c.surface + '; border:1px solid ' + c.outlineVariant + '; border-radius:var(--r-md); padding:16px; display:flex; flex-direction:column; gap:11px;">'
      +   '<span style="font-size:14px; font-weight:600;">' + T('Due Today') + (state.todayTasks.length ? ' <span style="font-size:12px; font-weight:600; padding:1px 7px; border-radius:var(--r-sm); background:' + c.surfaceContainerHigh + '; color:' + c.onSurfaceVariant + ';">' + state.todayTasks.length + '</span>' : '') + '</span>' + todayHtml + todayEmpty
      + '</div>'
      + '<div style="background:' + c.surface + '; border:1px solid ' + c.outlineVariant + '; border-radius:var(--r-md); padding:16px; display:flex; flex-direction:column; gap:12px;">'
      +   '<span class="interactive" data-action="toggleFeeds" role="button" aria-expanded="' + (state.feedsOpen ? 'true' : 'false') + '" aria-controls="feed-list" style="display:flex; align-items:center; gap:8px; font-size:14px; font-weight:600;">'
      +     '<svg class="tree-chevron' + (state.feedsOpen ? ' expanded' : '') + oneShotClass('feeds') + '" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 5l6 5-6 5"></path></svg>'
      +     '<span style="flex:1;">' + T('Department Calendars') + '</span>'
      +     (flatOpts.length ? '<span style="font-size:12px; font-weight:600; padding:1px 7px; border-radius:var(--r-sm); background:' + c.surfaceContainerHigh + '; color:' + c.onSurfaceVariant + ';">' + flatOpts.length + '</span>' : '')
      +   '</span>'
      +   '<div class="tree-children' + (state.feedsOpen ? ' expanded' : '') + oneShotClass('feeds') + '" id="feed-list">'
      +     '<div class="tree-children-inner" style="gap:12px;">' + mappingRows + mappingEmpty + '</div>'
      +   '</div>'
      + '</div>'
      + '</div>';
  }

  function taskModal(c) {
    if (state.newTaskModalPhase === 'closed') return '';
    var closing = state.newTaskModalPhase === 'closing';
    var mo = modalMotion('task', closing);
    var editing = !!state.editingTaskId;
    var f = state.newTaskForm;
    var editedTask = editing ? findLoadedTask(state.editingTaskId) : null;
    var readOnly = editing && !!editedTask && !canWriteDept(editedTask.deptId);
    var deptOptions = flattenDeptOptions().map(function (o) {
      return '<option value="' + esc(o.id) + '"' + (o.id === f.deptId ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('');
    var statusOptions = editing ? EDITABLE_STATUSES.map(function (id) {
      return '<option value="' + id + '"' + (id === f.status ? ' selected' : '') + '>' + TAB_LABELS[id] + '</option>';
    }).join('') : '';

    var lock = readOnly ? ' disabled' : '';
    var stacked = state.detailPhase === 'open' && !!state.detailTaskId;
    return '<div class="modal-overlay ' + mo.dim + '" data-backdrop="closeTaskModal" style="' + mo.dimStyle + 'position:fixed; background:rgba(0,0,0,' + (stacked ? '.25' : '.4') + '); display:flex; align-items:center; justify-content:center; z-index:55;">'
      + '<div role="dialog" data-scroll-key="' + esc('task:' + (state.editingTaskId || 'new')) + '" aria-modal="true" aria-label="' + esc(T(readOnly ? 'Task' : (editing ? 'Edit Task' : 'New Task'))) + '" tabindex="-1" class="' + mo.card + '" style="' + mo.cardStyle + 'width:400px; max-width:92vw; max-height:88vh; overflow-y:auto; background:' + c.surface + '; border-radius:var(--r-lg); padding:24px; display:flex; flex-direction:column; gap:14px; box-shadow:var(--e3);">'
      +   '<span style="font-size:18px; font-weight:600;">' + T(readOnly ? 'Task' : (editing ? 'Edit Task' : 'New Task')) + '</span>'
      +   (readOnly ? '<div style="font-size:12px; line-height:1.45; color:' + c.onSurfaceVariant + '; background:' + c.surfaceContainerHigh + '; padding:9px 11px; border-radius:var(--r-sm);">This task belongs to ' + esc(nodeLabel(editedTask.deptId)) + ', so it is read-only for you.</div>' : '')
      +   '<div style="display:flex; flex-direction:column; gap:5px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Title') + '</label>'
      +     '<input' + lock + ' id="newTaskTitleInput" data-form="newTaskForm" data-field="title" value="' + esc(f.title) + '" placeholder="' + T('e.g. Update onboarding checklist') + '" style="height:38px; padding:0 12px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:14px; background:' + c.surface + '; color:' + c.onSurface + ';"></input></div>'
      +   '<div style="display:flex; flex-direction:column; gap:5px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Description') + '</label>'
      +     '<textarea' + lock + ' id="newTaskDescInput" data-form="newTaskForm" data-field="description" rows="3" placeholder="' + T('What does done look like? Anything the next person needs to know.') + '" style="padding:9px 12px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:13px; line-height:1.5; font-family:inherit; resize:vertical; background:' + c.surface + '; color:' + c.onSurface + ';">' + esc(f.description || '') + '</textarea></div>'
      +   '<div style="display:flex; flex-direction:column; gap:5px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Department') + '</label>'
      +     mSelectFrom('<select' + lock + ' id="newTaskDeptSelect" data-form="newTaskForm" data-field="deptId" style="height:38px; padding:0 10px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:14px; background:' + c.surface + '; color:' + c.onSurface + ';"><option value="">' + T('— None —') + '</option>' + deptOptions + '</select>', c) + '</div>'
      +   '<div style="display:flex; gap:10px;">'
      +     '<div style="flex:1; display:flex; flex-direction:column; gap:5px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Assignee') + '</label>'
      +       assigneeControl(f, c, lock) + '</div>'
      +     '<div style="width:120px; display:flex; flex-direction:column; gap:5px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Priority') + '</label>'
      +       mSelectFrom('<select' + lock + ' id="newTaskPrioritySelect" data-form="newTaskForm" data-field="priority" style="height:38px; padding:0 10px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:14px; background:' + c.surface + '; color:' + c.onSurface + ';">'
      +         ['High', 'Medium', 'Low'].map(function (p) { return '<option value="' + p + '"' + (p === f.priority ? ' selected' : '') + '>' + T(p) + '</option>'; }).join('')
      +       '</select>', c) + '</div>'
      +   '</div>'
      +   '<div style="display:flex; gap:10px; flex-wrap:wrap;">'
      +     '<div style="flex:1; min-width:150px; display:flex; flex-direction:column; gap:5px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Due Date') + '</label>'
      +       '<input' + lock + ' id="newTaskDueInput" type="date" data-form="newTaskForm" data-field="due" value="' + esc(f.due) + '" style="height:38px; padding:0 12px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:14px; background:' + c.surface + '; color:' + c.onSurface + ';"></input></div>'
      +     '<div style="flex:1; min-width:150px; display:flex; flex-direction:column; gap:5px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Repeat') + '</label>'
      +       repeatControl(f, c, lock) + '</div>'
      +   '</div>'
      +   (f.recurrence ? '<div style="font-size:12px; line-height:1.45; color:' + c.onSurfaceVariant + '; margin-top:-6px;">' + esc(T('{rule}, counting from the due date. Finishing it files the next one.', { rule: describeRepeat(f.recurrence) })) + '</div>' : '')
      +   (editing
          ? ('<div style="display:flex; gap:10px; align-items:flex-end;">'
              + '<div style="flex:1; display:flex; flex-direction:column; gap:5px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Status') + '</label>'
              +   mSelectFrom('<select' + lock + ' id="newTaskStatusSelect" data-form="newTaskForm" data-field="status" style="height:38px; padding:0 10px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:14px; background:' + c.surface + '; color:' + c.onSurface + ';">' + statusOptions + '</select>', c) + '</div>'
              + '<label class="interactive" style="display:flex; align-items:center; gap:8px; height:38px; font-size:13px; cursor:pointer;" title="' + T('Include this task in the department calendar feed') + '"><input type="checkbox"' + lock + ' data-action="toggleTaskCalendar" ' + (f.calendarVisible ? 'checked' : '') + '></input>' + T('In calendar') + '</label>'
              + '</div>')
          : '')
      +   (editing ? '' : checklistSection(c, false, false))
      +   '<div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:6px;">'
      +     (editing && !readOnly ? '<div class="interactive" data-action="deleteTask" style="font-size:14px; font-weight:500; color:' + c.error + '; padding:8px 6px;">' + T('Delete') + '</div>' : '<span></span>')
      +     '<div style="display:flex; gap:10px;">'
      +       '<div class="interactive" data-action="closeTaskModal" style="display:flex; align-items:center; justify-content:center; height:40px; padding:0 18px; border-radius:var(--r-sm); color:' + c.onSurfaceVariant + '; font-size:14px; font-weight:500;">' + T(readOnly ? 'Close' : 'Cancel') + '</div>'
      +       (readOnly ? '' : '<div class="interactive" data-action="saveTask" style="display:flex; align-items:center; justify-content:center; height:40px; padding:0 20px; border-radius:var(--r-sm); background:' + c.primary + '; color:' + c.onPrimary + '; font-size:14px; font-weight:600;">' + (editing ? T('Save Changes') : T('Create Task')) + '</div>')
      +     '</div>'
      +   '</div>'
      + '</div></div>';
  }

  function repeatControl(f, c, lock) {
    var r = parseRepeat(f.recurrence);
    var fieldStyle = 'height:38px; padding:0 10px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:14px; background:' + c.surface + '; color:' + c.onSurface + ';';
    var opts = REPEAT_OPTIONS.map(function (o) {
      return '<option value="' + o[0] + '"' + (o[0] === r.freq ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('') + (r.freq === 'custom' ? '<option value="custom" selected>' + T('Custom (set on a phone)') + '</option>' : '');
    var select = mSelectFrom('<select' + lock + ' id="newTaskRepeatSelect" style="' + fieldStyle + '">' + opts + '</select>', c);
    if (!REPEAT_UNITS[r.freq]) return select;
    var unit = REPEAT_UNITS[r.freq];
    return '<div style="display:flex; gap:6px; align-items:center;">'
      + '<div style="flex:1; min-width:0;">' + select.replace('style="', 'style="width:100%; ') + '</div>'
      + (LANG === 'ko' ? '' : '<span style="font-size:12px; color:' + c.onSurfaceVariant + ';">every</span>')
      + '<input' + lock + ' id="newTaskRepeatInterval" type="number" min="1" max="999" value="' + r.interval + '" aria-label="' + T('Repeat every how many ' + unit[1]) + '" style="width:52px; ' + fieldStyle + ' padding:0 6px;"></input>'
      + (LANG === 'ko' ? '<span style="font-size:12px; color:' + c.onSurfaceVariant + '; white-space:nowrap;">' + { day: '일', week: '주', month: '개월', year: '년' }[unit[0]] + '마다</span>' : '')
      + '</div>';
  }

  // Steps inside a task. A new task collects them locally and hands them over
  // on create; an open one saves each change as it happens.
  function checklistSection(c, editing, readOnly) {
    var items = editing
      ? state.checklist
      : (state.newTaskForm.checklistItems || []).map(function (body, i) { return { id: i, body: body, done: false }; });
    var done = items.filter(function (x) { return x.done; }).length;
    var rows = items.map(function (it, i) {
      var box = editing
        ? '<input type="checkbox"' + (readOnly ? ' disabled' : '') + ' data-action="toggleChecklistItem" data-id="' + it.id + '"' + (it.done ? ' checked' : '') + ' aria-label="' + esc(it.body) + '" style="flex-shrink:0;"></input>'
        : '<span style="width:6px; height:6px; border-radius:50%; background:' + c.outline + '; flex-shrink:0; margin:0 5px;"></span>';
      var tools = readOnly ? '' : (
        (editing && items.length > 1
          ? '<span class="interactive checklist-tool" data-action="moveChecklistUp" data-id="' + it.id + '" title="' + T('Move up') + '"' + (i === 0 ? ' style="visibility:hidden;"' : '') + '>' + '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12l5-5 5 5"></path></svg></span>'
          + '<span class="interactive checklist-tool" data-action="moveChecklistDown" data-id="' + it.id + '" title="' + T('Move down') + '"' + (i === items.length - 1 ? ' style="visibility:hidden;"' : '') + '>' + '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 8l5 5 5-5"></path></svg></span>'
          : '')
        + '<span class="interactive checklist-tool" data-action="deleteChecklistItem" data-id="' + it.id + '" title="' + T('Remove') + '">' + ICON.close + '</span>');
      return '<div class="checklist-row' + oneShotClass('check:' + it.id) + '" style="display:flex; align-items:center; gap:9px; padding:5px 2px; border-radius:var(--r-sm); color:' + c.onSurfaceVariant + ';">'
        + box
        + '<span style="flex:1; min-width:0; font-size:13px; line-height:1.4; overflow-wrap:anywhere; color:' + (it.done ? c.onSurfaceVariant : c.onSurface) + '; text-decoration:' + (it.done ? 'line-through' : 'none') + ';">' + esc(it.body) + '</span>'
        + tools
        + '</div>';
    }).join('');
    var pct = items.length ? Math.round(done / items.length * 100) : 0;
    return '<div style="display:flex; flex-direction:column; gap:4px;">'
      + '<div style="display:flex; align-items:center; gap:8px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Checklist') + '</label>'
      +   (items.length && editing ? '<span style="font-size:12px; font-weight:600; color:' + c.onSurfaceVariant + ';">' + done + '/' + items.length + '</span>'
          + '<span style="flex:1; height:4px; border-radius:2px; background:' + c.surfaceContainerHigh + '; overflow:hidden;"><span style="display:block; height:100%; width:' + pct + '%; background:' + c.secondary + '; transition:width .3s;"></span></span>' : '')
      + '</div>'
      + rows
      + (readOnly ? (items.length ? '' : '<div style="font-size:12px; color:' + c.onSurfaceVariant + ';">' + T('No checklist.') + '</div>')
        : '<div style="display:flex; gap:6px; margin-top:2px;">'
          + '<input id="checklistDraftInput" data-field="checklistDraft" value="' + esc(state.checklistDraft || '') + '" maxlength="500" placeholder="' + T('Add a step and press Enter') + '" style="flex:1; min-width:0; height:34px; padding:0 11px; border-radius:var(--r-sm); border:1px dashed ' + c.outline + '; font-size:13px; background:' + c.surface + '; color:' + c.onSurface + ';"></input>'
          + '<div class="interactive" data-action="addChecklistItem" style="display:flex; align-items:center; justify-content:center; height:34px; padding:0 12px; border-radius:var(--r-sm); background:' + c.secondaryContainer + '; color:' + c.onSecondaryContainer + '; font-size:13px; font-weight:600; flex-shrink:0;">' + T('Add') + '</div>'
          + '</div>')
      + '</div>';
  }

  // Comments are open to every approved member: reading tasks already is, and
  // a comment does not change the work - asking another team about their task
  // is the point. Removing one is limited to its author (or an administrator).
  function commentThread(c) {
    var items = state.comments.map(function (cm) {
      return '<div class="' + oneShotClass('comment:' + cm.id).trim() + '" style="display:flex; flex-direction:column; gap:3px; padding:9px 0; border-bottom:1px solid ' + c.outlineVariant + ';">'
        + '<div style="display:flex; align-items:center; gap:8px;">'
        +   '<span style="font-size:12px; font-weight:600;">' + esc(cm.authorName) + '</span>'
        +   '<span style="font-size:12px; color:' + c.onSurfaceVariant + ';">' + esc(formatStamp(cm.createdAt)) + '</span>'
        +   ((cm.mine || isAdmin()) ? '<span class="interactive" data-action="deleteComment" data-id="' + cm.id + '" title="' + T('Delete comment') + '" style="margin-left:auto; display:flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:var(--r-sm); color:' + c.onSurfaceVariant + ';">' + ICON.close + '</span>' : '')
        + '</div>'
        + '<div style="font-size:13px; line-height:1.55; white-space:pre-wrap; color:' + c.onSurface + ';">' + renderCommentBody(cm.body, c) + '</div>'
        + '</div>';
    }).join('');

    return '<div style="display:flex; flex-direction:column; gap:6px; margin-top:8px; padding-top:14px; border-top:1px solid ' + c.outlineVariant + ';">'
      + '<span style="font-size:13px; font-weight:600;">' + T('Comments') + (state.comments.length ? ' (' + state.comments.length + ')' : '') + '</span>'
      + (state.comments.length ? items : '<div style="font-size:12px; color:' + c.onSurfaceVariant + '; padding:4px 0 8px 0;">' + T('No comments yet.') + '</div>')
      + '<div style="position:relative; display:flex; gap:8px; align-items:flex-end; margin-top:6px;">'
      +   '<textarea id="commentDraftInput" data-field="commentDraft" rows="2" placeholder="' + T('Add a comment - type @ to notify someone') + '" aria-autocomplete="list" style="flex:1; padding:8px 11px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:13px; line-height:1.5; font-family:inherit; resize:vertical; background:' + c.surface + '; color:' + c.onSurface + ';">' + esc(state.commentDraft || '') + '</textarea>'
      +   '<div class="interactive" data-action="postComment" style="display:flex; align-items:center; justify-content:center; height:36px; padding:0 16px; border-radius:var(--r-sm); background:' + c.secondaryContainer + '; color:' + c.onSecondaryContainer + '; font-size:13px; font-weight:600; flex-shrink:0;">' + T('Post') + '</div>'
      +   mentionPicker(c)
      + '</div>'
      + '</div>';
  }

  // Suggestions for the name being typed after "@". It opens upward, since
  // the comment box is at the bottom of the dialog.
  function mentionPicker(c) {
    if (!state.mention) return '';
    var list = mentionCandidates(state.mention.query);
    if (!list.length) return '';
    var items = list.map(function (m, i) {
      var active = i === state.mention.index;
      return '<div class="interactive" role="option" aria-selected="' + (active ? 'true' : 'false') + '" data-action="pickMention" data-id="' + m.id + '" style="display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:var(--r-sm); font-size:13px; background:' + (active ? c.primaryContainer : 'transparent') + '; color:' + (active ? c.onPrimaryContainer : c.onSurface) + ';">'
        + withImageFallback('/api/users/' + m.id + '/avatar?v=' + state.avatarVersion,
            '<div style="width:22px; height:22px; border-radius:50%; background:' + c.tertiaryContainer + '; color:' + c.onTertiaryContainer + '; font-size:12px; font-weight:600; display:flex; align-items:center; justify-content:center;">' + esc(computeInitials(m.displayName)) + '</div>', 22, '50%')
        + '<span>' + esc(m.displayName) + '</span>'
        + (m.deptId ? '<span style="margin-left:auto; font-size:12px; color:' + c.onSurfaceVariant + ';">' + esc(nodeLabel(m.deptId)) + '</span>' : '')
        + '</div>';
    }).join('');
    return '<div role="listbox" aria-label="' + T('People to mention') + '" style="position:absolute; left:0; bottom:calc(100% + 6px); width:260px; max-width:100%; background:' + c.surface + '; border:1px solid ' + c.outlineVariant + '; border-radius:var(--r-md); box-shadow:var(--e2); padding:5px; z-index:5;">' + items + '</div>';
  }

  // Comment stamps are stored UTC; show them in the reader's own time.
  function formatStamp(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var today = new Date();
    var sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    var time = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
    return sameDay ? time : (shortDate(d) + (LANG === 'ko' ? ' ' : ', ') + time);
  }

  // A reset's temporary password, shown to the administrator once.
  function resetResultBox(c) {
    var r = state.resetResult;
    if (!r) return '';
    return '<div class="' + oneShotClass('resetResult').trim() + '" style="display:flex; flex-direction:column; gap:7px; padding:13px; border-radius:var(--r-md); background:' + c.primaryContainer + '; color:' + c.onPrimaryContainer + ';">'
      + '<div style="display:flex; align-items:center; gap:8px;"><span style="font-size:13px; font-weight:600; flex:1;">' + esc(T('Temporary password for {name}', { name: r.name })) + '</span>'
      +   '<span class="interactive" data-action="dismissResetResult" title="' + T('Done') + '" style="display:flex; align-items:center; justify-content:center; width:24px; height:24px; border-radius:50%;">' + ICON.close + '</span></div>'
      + '<div style="display:flex; align-items:center; gap:8px;"><code style="flex:1; font-size:18px; letter-spacing:.06em; font-weight:600; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">' + esc(r.temp) + '</code>'
      +   '<span class="interactive" data-action="copyResetPassword" title="' + T('Copy') + '" style="display:flex; align-items:center; justify-content:center; width:30px; height:30px; border-radius:var(--r-sm);">' + (state.copiedToken === 'reset-pw' ? '<span class="anim-copied" style="display:flex;">' + ICON.check + '</span>' : ICON.copy) + '</span></div>'
      + '<div style="font-size:12px; line-height:1.45;">' + T('Give it to them in person or over a trusted channel. It is shown only now. They sign in with it and are asked for a password of their own straight away; it does not work for phone sync.') + '</div>'
      + '</div>';
  }

  function usersModal(c) {
    if (state.usersModalPhase === 'closed') return '';
    var closing = state.usersModalPhase === 'closing';
    var mo = modalMotion('users', closing);
    var deptOpts = flattenDeptOptions();

    var rows = state.users.map(function (u) {
      var isSelf = state.user && u.id === state.user.id;
      var pending = u.status === 'pending';
      var disabled = u.status === 'disabled';
      var badgeBg = pending ? c.errorContainer : (disabled ? c.surfaceVariant : c.secondaryContainer);
      var badgeFg = pending ? c.onErrorContainer : (disabled ? c.onSurfaceVariant : c.onSecondaryContainer);
      var badgeText = pending ? T('Waiting') : (disabled ? T('Disabled') : T('Active'));

      var deptSelect = mSelectFrom('<select data-user-dept="' + u.id + '" style="height:30px; padding:0 8px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:12px; background:' + c.surface + '; color:' + c.onSurface + ';">'
        + '<option value="">' + T('- No department -') + '</option>'
        + deptOpts.map(function (o) {
            return '<option value="' + esc(o.id) + '"' + (o.id === u.deptId ? ' selected' : '') + '>' + esc(o.label) + '</option>';
          }).join('')
        + '</select>', c);

      var roleControl = isSelf
        ? '<span style="font-size:12px; color:' + c.onSurfaceVariant + ';">' + esc(T(u.role === 'admin' ? 'admin (you)' : 'member (you)')) + '</span>'
        : '<span class="interactive" data-action="setUserRole" data-id="' + u.id + '" data-value="' + (u.role === 'admin' ? 'member' : 'admin') + '" style="font-size:12px; font-weight:500; color:' + c.primary + ';">'
          + (u.role === 'admin' ? T('Make member') : T('Make admin')) + '</span>';

      var resetControl = isSelf ? ''
        : '<span class="interactive" data-action="resetUserPassword" data-id="' + u.id + '" style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Reset password') + '</span>';

      var statusControl = pending
        ? '<span class="interactive" data-action="approveUser" data-id="' + u.id + '" style="font-size:12px; font-weight:600; color:' + c.primary + ';">' + T('Approve') + '</span>'
        : (isSelf ? ''
          : '<span class="interactive" data-action="setUserStatus" data-id="' + u.id + '" data-value="' + (disabled ? 'active' : 'disabled') + '" style="font-size:12px; font-weight:500; color:' + (disabled ? c.primary : c.error) + ';">'
            + (disabled ? T('Re-enable') : T('Disable')) + '</span>');

      return '<div style="display:flex; flex-direction:column; gap:7px; padding:12px 0; border-bottom:1px solid ' + c.outlineVariant + ';">'
        + '<div style="display:flex; align-items:center; gap:8px;">'
        +   '<span style="font-size:13px; font-weight:500;">' + esc(u.displayName) + '</span>'
        +   '<span style="font-size:12px; color:' + c.onSurfaceVariant + ';">@' + esc(u.username) + '</span>'
        +   (u.mustChangePassword ? '<span style="margin-left:auto; font-size:12px; font-weight:600; padding:2px 8px; border-radius:var(--r-sm); background:' + c.tertiaryContainer + '; color:' + c.onTertiaryContainer + ';">' + T('Needs new password') + '</span>' : '')
        +   '<span style="' + (u.mustChangePassword ? '' : 'margin-left:auto; ') + 'font-size:12px; font-weight:600; padding:2px 8px; border-radius:var(--r-sm); background:' + badgeBg + '; color:' + badgeFg + ';">' + badgeText + '</span>'
        + '</div>'
        + '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">'
        +   deptSelect
        +   '<span style="display:flex; align-items:center; gap:12px; margin-left:auto; flex-wrap:wrap; justify-content:flex-end;">' + roleControl + resetControl + statusControl + '</span>'
        + '</div>'
        + '</div>';
    }).join('');

    var waiting = pendingUserCount();
    return '<div class="modal-overlay ' + mo.dim + '" data-backdrop="closeUsers" style="' + mo.dimStyle + 'position:fixed; background:rgba(0,0,0,.4); display:flex; align-items:center; justify-content:center; z-index:50;">'
      + '<div role="dialog" data-scroll-key="accounts" aria-modal="true" aria-label="' + esc(T('Accounts')) + '" tabindex="-1" class="' + mo.card + '" style="' + mo.cardStyle + 'width:520px; max-width:94vw; max-height:88vh; overflow-y:auto; background:' + c.surface + '; border-radius:var(--r-lg); padding:24px; display:flex; flex-direction:column; gap:10px; box-shadow:var(--e3);">'
      +   '<span style="font-size:18px; font-weight:600;">' + T('Accounts') + '</span>'
      +   '<div style="font-size:12px; line-height:1.5; color:' + c.onSurfaceVariant + ';">'
      +     (waiting > 0 ? T(waiting === 1 ? '{n} account waiting for approval.' : '{n} accounts waiting for approval.', { n: waiting }) + ' ' : '')
      +     T('A member can only add or change work in their own department, so give each person a department before approving them.')
      +   '</div>'
      +   resetResultBox(c)
      +   (state.users.length === 0 ? '<div style="font-size:13px; color:' + c.onSurfaceVariant + '; padding:12px 0;">' + T('No accounts yet.') + '</div>' : rows)
      +   '<div style="display:flex; justify-content:flex-end; margin-top:8px;">'
      +     '<div class="interactive" data-action="closeUsers" style="display:flex; align-items:center; justify-content:center; height:40px; padding:0 20px; border-radius:var(--r-sm); background:' + c.primary + '; color:' + c.onPrimary + '; font-size:14px; font-weight:600;">' + T('Done') + '</div>'
      +   '</div>'
      + '</div></div>';
  }

  // Value -1 means "someone who has no account here" and reveals the free-text
  // box; 0 means unassigned. Anything above 0 is a real user id.
  function assigneeSelectValue(f) {
    if (Number(f.assigneeId) > 0) return String(f.assigneeId);
    return f.assignee ? '-1' : '0';
  }

  function assigneeControl(f, c, lock) {
    var current = assigneeSelectValue(f);
    var fieldStyle = 'height:38px; padding:0 10px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:14px; background:' + c.surface + '; color:' + c.onSurface + ';';
    var options = '<option value="0"' + (current === '0' ? ' selected' : '') + '>&mdash; ' + T('Unassigned') + ' &mdash;</option>'
      + state.members.map(function (m) {
          return '<option value="' + m.id + '"' + (current === String(m.id) ? ' selected' : '') + '>' + esc(m.displayName) + '</option>';
        }).join('')
      + '<option value="-1"' + (current === '-1' ? ' selected' : '') + '>&mdash; ' + T('Someone else') + ' &mdash;</option>';

    var select = mSelectFrom('<select' + lock + ' id="newTaskAssigneeSelect" data-form="newTaskForm" data-field="assigneeId" style="' + fieldStyle + '">' + options + '</select>', c);
    if (current !== '-1') return select;
    return select
      + '<input' + lock + ' id="newTaskAssigneeInput" data-form="newTaskForm" data-field="assignee" value="' + esc(f.assignee) + '" placeholder="' + T('Name') + '" style="margin-top:6px; ' + fieldStyle + '"></input>';
  }

  // ---- guide ----
  // The how-to lives in the app itself, one click from the logo. It follows
  // the reader's system language, and describes only behaviour that actually
  // exists - if a feature changes, this is the place to change with it.
  function guideLang() { return LANG; }

  function guideSections() {
    var u = state.user || {};
    var ctx = {
      role: u.role,
      username: u.username || '',
      dept: u.deptId ? nodeLabel(u.deptId) : '',
      caldav: location.origin + '/caldav/',
      code: function (s) { return '<code class="guide-code">' + esc(s) + '</code>'; },
      b: function (s) { return '<strong>' + esc(s) + '</strong>'; }
    };
    return guideLang() === 'ko' ? guideSectionsKo(ctx) : guideSectionsEn(ctx);
  }

  function guideSectionsKo(x) {
    var b = x.b, code = x.code;
    var sections = [
      { id: 'start', title: '시작하기', body:
        '<p>처음 만든 계정만 관리자가 되고, 그 뒤로 가입한 계정은 ' + b('승인 대기') + ' 상태가 됩니다. 관리자가 부서를 배정하고 승인해야 로그인할 수 있습니다.</p>'
        + '<p>' + (x.role === 'admin'
            ? '지금 계정은 ' + b('관리자') + '입니다. 모든 부서의 작업을 바꿀 수 있습니다.'
            : (x.dept
                ? '지금 계정의 부서는 ' + b(x.dept) + '입니다. 이 부서와 그 아래 부서의 작업을 만들고 바꿀 수 있고, 다른 부서의 작업은 볼 수만 있습니다.'
                : '지금 계정은 아직 부서가 배정되지 않아 작업을 볼 수만 있습니다. 관리자에게 부서 배정을 요청하세요.'))
        + '</p>' },

      { id: 'tasks', title: '작업 만들고 고치기', body:
        '<p>' + b('New Task') + ' 버튼으로 작업을 만듭니다. 제목, 설명, 부서, 담당자, 우선순위, 기한을 정할 수 있습니다. 휴대폰에서는 오른쪽 아래의 둥근 버튼입니다.</p>'
        + '<p>작업을 누르면 ' + b('상세 창') + '이 열립니다. 본문, 체크리스트, 첨부파일, 코멘트를 한곳에서 보고, 상태는 위쪽 목록에서 바로 바꿀 수 있습니다. 제목이나 기한 같은 항목을 고치려면 오른쪽 위 ' + b('톱니바퀴') + ' 버튼을 누르세요. 편집을 마치면 상세 창으로 돌아옵니다.</p>'
        + '<p>' + b('In calendar') + '는 작업을 만든 뒤 편집 창에서 켤 수 있습니다. 본문에 적은 웹 주소는 누르면 새 탭에서 열립니다.</p>'
        + '<p>' + b('담당자') + '는 목록에서 사람을 고르거나, 계정이 없는 사람이면 ' + b('Someone else') + '를 골라 이름을 직접 적습니다. 계정으로 고른 담당자만 ' + b('My Tasks') + '에 잡힙니다.</p>'
        + '<p>기한이 지났는데 끝나지 않은 작업은 자동으로 ' + b('Overdue') + '로 표시됩니다. 따로 설정하는 상태가 아닙니다.</p>' },

      { id: 'repeat', title: '반복 작업과 체크리스트', body:
        '<p>' + b('Repeat') + '에서 매일, 평일마다, 매주, 매월, 매년 반복을 고를 수 있고, 옆 칸에 숫자를 넣으면 "2주마다"처럼 간격을 정합니다. 반복은 기한을 기준으로 계산하므로 기한이 비어 있으면 오늘로 채워집니다.</p>'
        + '<p>반복 작업을 완료하면 그 작업은 Done으로 남고, 다음 기한의 작업이 새로 만들어집니다. 몇 주 늦게 끝내도 밀린 만큼 쌓이지 않고 오늘 이후의 가장 가까운 날짜로 한 번만 만들어집니다. 목록에서는 반복 표시가 붙습니다.</p>'
        + '<p>' + b('Checklist') + '에는 작업을 잘게 나눈 단계를 적습니다. 입력하고 Enter를 누르면 추가되고, 체크하면 목록에 "2/5"처럼 진행률이 보입니다. 반복 작업의 다음 회차에는 체크리스트가 체크 해제된 채로 따라갑니다.</p>' },

      { id: 'find', title: '찾아보기', body:
        '<ul>'
        + '<li>왼쪽 목록에서 부서를 고르면 그 부서와 하위 부서의 작업만 보입니다. ' + b('All Tasks') + '는 전체, ' + b('My Tasks') + '는 나에게 배정된 작업입니다.</li>'
        + '<li>위쪽 탭으로 상태별로 거릅니다. 탭 옆 숫자는 지금 조건에서의 개수입니다.</li>'
        + '<li>' + b('Filter') + '에서 정렬(만든 순서, 기한순, 우선순위, 최근 수정순, 제목)을 고르고, 담당자·우선순위·캘린더 노출 여부로 거릅니다. 정렬은 이 브라우저에 기억됩니다.</li>'
        + '<li>검색창은 제목, 담당자, 부서 이름에 더해 설명, 체크리스트, 코멘트, 첨부파일 이름까지 찾습니다. 제목 밖에서 찾은 결과는 어디서 찾았는지 그 부분을 함께 보여 줍니다.</li>'
        + '</ul>' },

      { id: 'today', title: '오늘 할 일', body:
        '<p>오른쪽의 ' + b('Due Today') + '에는 오늘이 기한이거나 이미 기한이 지난 미완료 작업이 모입니다. 네모를 체크하면 그 작업이 완료되고, 제목을 누르면 작업이 열립니다.</p>' },

      { id: 'talk', title: '코멘트와 알림', body:
        '<p>작업 편집 창 아래에서 코멘트를 남길 수 있습니다. 코멘트는 다른 부서 작업에도 남길 수 있습니다. 지울 수 있는 건 내가 쓴 코멘트뿐입니다.</p>'
        + '<p>코멘트에 ' + code('@') + '를 치면 사람 목록이 뜹니다. 골라서 넣으면 그 사람에게 알림이 갑니다.</p>'
        + '<p>종 모양 버튼의 ' + b('For you') + '에는 나에게 온 알림만 모입니다. 누가 작업을 나에게 배정했을 때, 코멘트에서 나를 불렀을 때, 내가 담당한 작업에 코멘트가 달렸을 때입니다. 숫자는 안 읽은 알림 개수이고, 누르면 그 작업이 열립니다. 읽음 표시는 계정에 저장되어 다른 기기에서도 같습니다.</p>'
        + '<p>' + b('Activity') + '에는 누가 무엇을 바꿨는지가 모두의 공통 기록으로 쌓입니다. 다른 사람이 바꾼 내용은 새로고침하지 않아도 화면에 바로 반영됩니다.</p>'
        + '<p>' + b('For you') + ' 아래의 스위치를 켜면, 이 탭이 뒤에 가려져 있을 때 컴퓨터 알림으로도 알려 줍니다. 브라우저가 HTTPS로 연 페이지에서만 허용합니다.</p>' },

      { id: 'trash', title: '휴지통', body:
        '<p>작업을 지우면 바로 사라지지 않고 ' + b('휴지통') + '으로 갑니다. 지운 직후 화면 아래에 뜨는 ' + b('Undo') + '를 누르면 바로 되돌릴 수 있습니다.</p>'
        + '<p>왼쪽 목록 아래 ' + b('Trash') + '에서 지운 작업을 볼 수 있습니다. ' + b('Restore') + '를 누르면 코멘트와 체크리스트까지 원래대로 돌아옵니다. 휴지통의 작업은 ' + b('10일') + ' 뒤에 완전히 지워집니다. 휴대폰 미리 알림에서 지운 작업도 휴지통으로 갑니다.</p>' },

      { id: 'phone', title: '아이폰 미리 알림과 연결', body:
        '<p>아이폰 ' + b('설정 → 미리 알림 → 계정 → 계정 추가 → 기타 → CalDAV 계정 추가') + '에서 아래처럼 입력합니다.</p>'
        + '<table class="guide-table">'
        + '<tr><th>서버</th><td>' + code(x.caldav) + '</td></tr>'
        + '<tr><th>사용자 이름</th><td>' + (x.username ? code(x.username) : 'Directive 로그인 아이디') + '</td></tr>'
        + '<tr><th>암호</th><td>' + b('앱 비밀번호') + '</td></tr>'
        + '</table>'
        + '<p>' + b('앱 비밀번호') + '는 내 사진 → ' + b('Phone sync') + '에서 기기마다 하나씩 만듭니다. 휴대폰에 진짜 비밀번호를 저장하지 않아도 되고, 폰을 잃어버리면 그 기기 줄만 ' + b('Revoke') + '해서 끊을 수 있습니다. 만든 직후에 한 번만 보여 주니 바로 입력하세요. 원래 로그인 비밀번호도 여전히 통하지만 앱 비밀번호를 권합니다.</p>'
        + '<p>반복 작업은 폰에서도 반복으로 보입니다. 부서마다 미리 알림 목록이 하나씩 생깁니다. 폰에서 체크하거나 제목·기한을 바꾸면 Directive에도 반영되고, 반대도 마찬가지입니다. 부서와 담당자는 폰에서 바꿀 수 없고 Directive에서만 바뀝니다.</p>' },

      { id: 'feed', title: '구글 캘린더 · 아웃룩', body:
        '<p>구글 캘린더와 아웃룩은 위의 연결 방식을 지원하지 않습니다. 대신 부서마다 구독 주소가 있습니다. 오른쪽 ' + b('Department Calendars') + '를 펼쳐 복사 버튼으로 주소를 복사한 뒤, 캘린더 앱에서 ' + b('URL로 구독') + '에 붙여 넣으면 기한이 자동으로 들어옵니다. 따로 내보낼 필요가 없습니다.</p>'
        + '<p>이 경로는 ' + b('읽기 전용') + '입니다. 기한이 있고 ' + b('In calendar') + '가 켜진 작업만 일정으로 보입니다. 구글 캘린더는 새로 고치는 주기가 길어서 반영이 몇 시간 늦을 수 있습니다.</p>' },

      { id: 'files', title: '첨부파일과 아이콘', body:
        '<p>상세 창의 ' + b('Add files') + '로 파일을 올립니다. 파일을 창 위로 끌어다 놓거나, 스크린샷을 복사한 뒤 상세 창에서 붙여 넣어도 됩니다. 파일 하나는 20MB까지이고, 사진은 미리보기로 보이며 누르면 크게 열립니다. 다른 파일은 눌러서 내려받습니다.</p>'
        + '<p>제목 위의 ' + b('Add icon') + '을 누르면 이모지를 고르거나 사진을 올려 작업 아이콘으로 쓸 수 있습니다. 아이콘은 목록에서도 제목 옆에 보입니다. 반복 작업의 다음 회차에는 아이콘이 따라가지만, 첨부파일은 원래 회차에 남습니다.</p>' },

      { id: 'me', title: '내 설정', body:
        '<p>오른쪽 위 내 사진을 누르면 표시 이름과 프로필 사진을 바꿀 수 있습니다. 강조 색과 밝은·어두운 화면도 고를 수 있는데, 이 두 가지는 이 브라우저에만 저장됩니다.</p>'
        + '<p>' + b('Change password') + '에서 비밀번호를 바꿉니다. 바꾸면 다른 브라우저와 기기의 로그인은 모두 끊기고, 폰 동기화용 앱 비밀번호는 그대로 유지됩니다. 비밀번호를 잊었으면 관리자에게 재설정을 부탁하세요. 받은 임시 비밀번호로 로그인하면 바로 새 비밀번호를 정하는 화면이 나옵니다.</p>' },

      { id: 'keys', title: '키보드와 휴대폰', body:
        '<ul>'
        + '<li>' + b('Tab') + '으로 이동하고 ' + b('Enter') + ' 또는 ' + b('Space') + '로 누르며, ' + b('Esc') + '로 열린 창을 닫습니다.</li>'
        + '<li>왼쪽 위 줄 세 개 버튼을 누르면 부서 목록이 화면 위로 열립니다. 부서를 고르거나 바깥을 누르면 닫힙니다. 휴대폰에서는 달력 버튼이 오늘 할 일과 캘린더를 엽니다.</li>'
        + '</ul>' }
    ];
    if (x.role === 'admin') {
      sections.push({ id: 'admin', title: '관리자 전용', admin: true, body:
        '<ul>'
        + '<li>' + b('계정 승인') + ': 내 사진 → ' + b('Accounts') + '. 부서를 먼저 고른 뒤 ' + b('Approve') + '를 누릅니다. 역할 변경과 비활성화도 여기서 합니다.</li>'
        + '<li>' + b('비밀번호 재설정') + ': ' + b('Accounts') + '에서 ' + b('Reset password') + '를 누르면 임시 비밀번호가 한 번만 표시됩니다. 직접 전해 주세요. 그 사람은 모든 곳에서 로그아웃되고, 임시 비밀번호로 들어오면 새 비밀번호부터 정해야 합니다. 관리자도 다른 사람의 비밀번호를 볼 수는 없습니다.</li>'
        + '<li>' + b('부서') + ': 왼쪽 아래 ' + b('Add Department') + '로 만들고, 부서 옆 점 세 개 버튼으로 이름을 바꾸거나 지웁니다. 부서를 지워도 그 안의 작업은 남습니다.</li>'
        + '<li>' + b('앱 이름과 아이콘') + ': 이름은 내 사진 메뉴에서, 아이콘은 왼쪽 위 로고를 눌러 바꿉니다. 로고 메뉴에서 기본 아이콘으로 되돌릴 수도 있습니다.</li>'
        + '<li>' + b('기한 알림') + ': 내 사진 → ' + b('Due-date reminders') + '에서 켜고 끄며 시각을 정합니다(기본 오전 9시, 서버 시계 기준). 그 시각에 담당자마다 기한이 오늘인 작업과 내일인 작업을 알림으로 보냅니다.</li>'
        + '<li>' + b('백업') + ': 내 사진 → ' + b('Backups') + '에서 매일 자동 백업을 켜고 시각(서버 시계 기준)과 보관 개수를 정합니다. ' + b('Back up now') + '로 바로 한 부 만들 수 있고, 목록에서 내려받아 서버 밖에도 보관하세요. 서버가 그 시각에 꺼져 있었으면 켜지자마자 그날 백업을 합니다. 백업 폴더는 서버를 켤 때 ' + code('-backup-dir') + '로 정하며, 기본값은 DB 파일 옆 ' + code('backups') + ' 폴더입니다.</li>'
        + '</ul>' });
    }
    return sections;
  }

  function guideSectionsEn(x) {
    var b = x.b, code = x.code;
    var sections = [
      { id: 'start', title: 'Getting started', body:
        '<p>Only the first account created becomes the administrator. Everyone who signs up after that is ' + b('waiting for approval') + ' until an administrator puts them in a department and approves them.</p>'
        + '<p>' + (x.role === 'admin'
            ? 'You are an ' + b('administrator') + ', so you can change work in every department.'
            : (x.dept
                ? 'You are in ' + b(x.dept) + '. You can add and change work in that department and anything nested under it; work in other departments is yours to read.'
                : 'Your account has no department yet, so you can read but not add anything. Ask an administrator to put you in one.'))
        + '</p>' },

      { id: 'tasks', title: 'Creating and editing tasks', body:
        '<p>Use ' + b('New Task') + ' to add one, with a title, description, department, assignee, priority and due date. On a phone it is the round button at the bottom right.</p>'
        + '<p>Click a task to open its ' + b('details') + ': the description, checklist, files and comments in one place, with the status changeable right at the top. To change its title, due date or other fields, use the ' + b('gear') + ' button at the top right; when you finish editing you come back to the details.</p>'
        + '<p>' + b('In calendar') + ' can be switched on in the editor once the task exists. Web addresses in a description open in a new tab.</p>'
        + '<p>Pick an ' + b('assignee') + ' from the list of people, or choose ' + b('Someone else') + ' to type a name for someone without an account. Only an assignee picked from the list shows up in ' + b('My Tasks') + '.</p>'
        + '<p>Anything past its due date and not finished is marked ' + b('Overdue') + ' on its own. It is not a status you set.</p>' },

      { id: 'repeat', title: 'Repeating tasks and checklists', body:
        '<p>' + b('Repeat') + ' makes a task come back daily, every weekday, weekly, monthly or yearly; the number beside it sets the gap, as in every 2 weeks. The repeat counts from the due date, so an empty due date is filled with today.</p>'
        + '<p>Finishing a repeating task leaves it under Done and files the next one with the next due date. Finishing one weeks late does not pile up the missed ones: you get a single task for the nearest date from today on. Repeating tasks carry a loop mark in the list.</p>'
        + '<p>The ' + b('Checklist') + ' breaks a task into steps. Type one and press Enter to add it; ticking steps shows progress like 2/5 in the list. The next occurrence of a repeating task gets the same checklist, unticked.</p>' },

      { id: 'find', title: 'Finding things', body:
        '<ul>'
        + '<li>Pick a department on the left to see its work and everything nested under it. ' + b('All Tasks') + ' is everything; ' + b('My Tasks') + ' is what is assigned to you.</li>'
        + '<li>The tabs filter by status. The number beside each is the count under whatever else you have filtered.</li>'
        + '<li>The search box looks through titles, assignees and departments, and also inside tasks: descriptions, checklists, comments and file names. A hit found outside the title shows the words it was found in.</li>'
        + '<li>' + b('Filter') + ' sorts the list (oldest first, due date, priority, recently updated, or title) and narrows it by assignee, priority, and whether a task is in the calendar. The sort is remembered in this browser.</li>'
        + '<li>Search covers titles, assignees and department names.</li>'
        + '</ul>' },

      { id: 'today', title: 'Due today', body:
        '<p>' + b('Due Today') + ' on the right collects unfinished work due today or already late. Tick the box to complete a task, or click its title to open it.</p>' },

      { id: 'talk', title: 'Comments and notifications', body:
        '<p>Every task has a comment thread at the bottom of its editor. You can comment on another department&rsquo;s task; you can only delete your own comments.</p>'
        + '<p>Type ' + code('@') + ' in a comment to pick a person; they are notified.</p>'
        + '<p>The bell&rsquo;s ' + b('For you') + ' tab holds what is meant for you: someone assigning you a task, mentioning you, or commenting on work assigned to you. The number is how many are unread, and clicking one opens its task. Read or unread is kept with your account, so it is the same on every device.</p>'
        + '<p>' + b('Activity') + ' is the shared record of who changed what. Changes other people make appear without reloading.</p>'
        + '<p>The switch under ' + b('For you') + ' adds desktop alerts while this tab is in the background. Browsers only allow them on a page opened over HTTPS.</p>' },

      { id: 'trash', title: 'Trash', body:
        '<p>Deleting a task moves it to the ' + b('trash') + ' rather than losing it, and the bar that appears at the bottom has an ' + b('Undo') + '.</p>'
        + '<p>' + b('Trash') + ' at the bottom of the left-hand list shows what was deleted. ' + b('Restore') + ' puts a task back with its comments and checklist. Anything in the trash is removed for good after ' + b('10 days') + '. A task deleted in a phone&rsquo;s reminders app lands there too.</p>' },

      { id: 'phone', title: 'Your phone’s reminders app', body:
        '<p>On iPhone, go to ' + b('Settings → Reminders → Accounts → Add Account → Other → Add CalDAV Account') + ' and enter:</p>'
        + '<table class="guide-table">'
        + '<tr><th>Server</th><td>' + code(x.caldav) + '</td></tr>'
        + '<tr><th>User Name</th><td>' + (x.username ? code(x.username) : 'your Directive username') + '</td></tr>'
        + '<tr><th>Password</th><td>an ' + b('app password') + '</td></tr>'
        + '</table>'
        + '<p>Make an ' + b('app password') + ' for each device under your photo → ' + b('Phone sync') + '. The phone then never holds your real password, and a lost phone is one ' + b('Revoke') + ' away from being cut off. It is shown once, straight after you create it, so enter it on the device then. Your account password still works here, but an app password is the better choice.</p>'
        + '<p>Repeating tasks show as repeating on the phone too. Each department becomes a list. Ticking something off on your phone, or changing its title or due date, comes back here, and changes here go out to the phone. Department and assignee can only be changed in Directive.</p>' },

      { id: 'feed', title: 'Google Calendar and Outlook', body:
        '<p>Neither can use the account above. They subscribe by URL instead: open ' + b('Department Calendars') + ' on the right, copy a department&rsquo;s link, and add it in your calendar as a subscribed calendar. Due dates then show up on their own, with no export step.</p>'
        + '<p>That route is ' + b('read-only') + ', and carries only tasks that have a due date with ' + b('In calendar') + ' switched on. Google refreshes subscribed calendars on its own slow schedule, so expect a delay of hours.</p>' },

      { id: 'files', title: 'Attachments and icons', body:
        '<p>' + b('Add files') + ' in a task&rsquo;s details uploads files; you can also drop files onto the window, or paste a copied screenshot while the details are open. Each file can be up to 20 MB. Pictures show as previews and open large when clicked; other files download.</p>'
        + '<p>' + b('Add icon') + ' above the title picks an emoji or uploads a picture as the task&rsquo;s icon, which also shows beside its title in the list. The next occurrence of a repeating task keeps the icon; attachments stay with the occurrence they were added to.</p>' },

      { id: 'me', title: 'Your settings', body:
        '<p>Your photo at the top right opens your display name and picture. The accent colour and light or dark appearance are there too; those two are remembered in this browser only.</p>'
        + '<p>' + b('Change password') + ' sets a new password. Your other browsers and devices are signed out; app passwords for phone sync keep working. If you forget it, ask an administrator to reset it: signing in with the temporary password they give you goes straight to choosing a new one.</p>' },

      { id: 'keys', title: 'Keyboard and phone', body:
        '<ul>'
        + '<li>' + b('Tab') + ' moves, ' + b('Enter') + ' or ' + b('Space') + ' activates, and ' + b('Esc') + ' closes whatever is open.</li>'
        + '<li>The menu button at the top left slides the departments in over the page; picking one, or clicking outside, puts them away. On a phone the calendar button holds today&rsquo;s work and the calendar.</li>'
        + '</ul>' }
    ];
    if (x.role === 'admin') {
      sections.push({ id: 'admin', title: 'For administrators', admin: true, body:
        '<ul>'
        + '<li>' + b('Approving accounts') + ': your photo → ' + b('Accounts') + '. Choose a department first, then ' + b('Approve') + '. Roles and disabling live there too.</li>'
        + '<li>' + b('Resetting a password') + ': ' + b('Reset password') + ' in ' + b('Accounts') + ' shows a temporary password once; hand it over yourself. The person is signed out everywhere and has to choose a new password when they sign in with it. No administrator can see anyone&rsquo;s password.</li>'
        + '<li>' + b('Departments') + ': ' + b('Add Department') + ' at the bottom left; the three-dot button beside a department renames or deletes it. Deleting one keeps the work filed under it.</li>'
        + '<li>' + b('App name and icon') + ': the name is in your photo menu; the icon is changed, or put back to the default, from the menu that opens when you click the logo.</li>'
        + '<li>' + b('Due-date reminders') + ': your photo → ' + b('Due-date reminders') + ' turns them on or off and sets the time (9:00 by default, by the server&rsquo;s clock). At that time each person is notified of their unfinished tasks due today and due tomorrow.</li>'
        + '<li>' + b('Backups') + ': your photo → ' + b('Backups') + ' turns on a daily backup at a time you choose (by the server&rsquo;s clock) and keeps the newest few. ' + b('Back up now') + ' makes one on the spot, and each can be downloaded so a copy lives off the server. If the server was off at the set time, that day&rsquo;s backup runs as soon as it starts. The folder is set with ' + code('-backup-dir') + ' when starting the server; by default it is ' + code('backups') + ' beside the database.</li>'
        + '</ul>' });
    }
    return sections;
  }

  function openGuide() {
    focusDialogOnNextRender();
    setState({ guideModalPhase: 'open', accountOpen: false, dropdownClosing: '' });
  }

  function closeGuide() {
    if (state.guideModalPhase !== 'open') return;
    setState({ guideModalPhase: 'closing' });
    setTimeout(function () { if (state.guideModalPhase === 'closing') setState({ guideModalPhase: 'closed' }); }, MODAL_CLOSE_MS);
  }

  function jumpToGuideSection(id) {
    var el = document.getElementById('guide-' + id);
    if (!el || !el.scrollIntoView) return;
    // The stylesheet switches motion off for anyone who asked for less of it,
    // but a scroll requested from script ignores that, so it has to ask too.
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
  }

  function guideModal(c) {
    if (state.guideModalPhase === 'closed') return '';
    var closing = state.guideModalPhase === 'closing';
    var mo = modalMotion('guide', closing);
    var sections = guideSections();
    var index = sections.map(function (s) {
      return '<span class="interactive guide-chip" data-action="jumpToGuideSection" data-id="' + s.id + '" style="background:' + (s.admin ? c.tertiaryContainer : c.surfaceContainerHigh) + '; color:' + (s.admin ? c.onTertiaryContainer : c.onSurfaceVariant) + ';">' + esc(s.title) + '</span>';
    }).join('');
    var body = sections.map(function (s) {
      return '<section id="guide-' + s.id + '" class="guide-section">'
        + '<h3 style="color:' + (s.admin ? c.tertiary : c.onSurface) + ';">' + esc(s.title) + '</h3>'
        + '<div style="color:' + c.onSurfaceVariant + ';">' + s.body + '</div>'
        + '</section>';
    }).join('');

    return '<div class="modal-overlay ' + mo.dim + '" data-backdrop="closeGuide" style="' + mo.dimStyle + 'position:fixed; background:rgba(0,0,0,.4); display:flex; align-items:center; justify-content:center; z-index:50;">'
      + '<div role="dialog" aria-modal="true" aria-label="' + esc(T('How to use {app}', { app: state.appName })) + '" tabindex="-1" class="guide-card ' + mo.card + '" style="' + mo.cardStyle + 'background:' + c.surface + '; color:' + c.onSurface + '; --guide-rule:' + c.outlineVariant + '; --guide-code-bg:' + c.surfaceContainerHigh + ';">'
      +   '<div style="display:flex; align-items:center; gap:12px; padding:22px 24px 10px 24px;">'
      +     brandIconHtml(c.primaryContainer, c.onPrimaryContainer, 32, 'none')
      +     '<div style="flex:1; min-width:0;"><div style="font-size:18px; font-weight:600;">' + esc(T('How to use {app}', { app: state.appName })) + '</div>'
      +       '<div style="font-size:12px; color:' + c.onSurfaceVariant + ';">' + esc(state.user ? state.user.displayName : '') + ' · ' + esc(guideLang() === 'ko' ? (state.user && state.user.role === 'admin' ? '관리자' : '멤버') : (state.user && state.user.role === 'admin' ? 'administrator' : 'member')) + '</div></div>'
      +     '<span class="interactive" data-action="closeGuide" title="' + T('Close') + '" style="display:flex; align-items:center; justify-content:center; width:32px; height:32px; border-radius:50%; color:' + c.onSurfaceVariant + ';">' + ICON.close + '</span>'
      +   '</div>'
      +   '<nav class="guide-index" aria-label="' + T('Guide sections') + '" data-scroll-key="guide-index">' + index + '</nav>'
      +   '<div class="guide-body" data-scroll-key="guide">' + body + '</div>'
      + '</div></div>';
  }

  // ---- task detail view ----
  function taskDetailModal(c) {
    if (state.detailPhase === 'closed' || !state.detailTaskId) return '';
    var t = detailTask();
    if (!t) return '';
    var writable = canWriteDept(t.deptId);
    var maps = styleMaps(c);
    var v = taskView(t, maps, c);
    var gear = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="' + GEAR_PATH + '"></path><circle cx="12" cy="12" r="3"></circle></svg>';

    // With no icon yet, the same spot holds a faint placeholder that adds one.
    var smiley = '<svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="7.5"></circle><path d="M7 12c.8 1 1.8 1.5 3 1.5s2.2-.5 3-1.5"></path><path d="M7.5 8h.01M12.5 8h.01" stroke-width="2.2"></path></svg>';
    var iconBlock = t.icon
      ? (writable
          ? '<span class="interactive detail-icon" data-action="toggleIconPicker" title="' + T('Change icon') + '" aria-label="' + T('Change icon') + '">' + taskIconHtml(t, 36) + '</span>'
          : '<span class="detail-icon">' + taskIconHtml(t, 36) + '</span>')
      : (writable ? '<span class="interactive detail-add-icon" data-action="toggleIconPicker" title="' + T('Add icon') + '" aria-label="' + T('Add icon') + '" style="color:' + c.onSurfaceVariant + '; border-color:' + c.outlineVariant + ';">' + smiley + '</span>' : '');

    var statusControl = writable
      ? mSelectFrom('<select id="detailStatusSelect" aria-label="' + T('Status') + '" style="height:30px; padding:0 8px 0 13px; border-radius:var(--r-sm); border:none; font-size:13px; font-weight:600; background:' + v.statusBg + '; color:' + v.statusColor + ';">'
        + EDITABLE_STATUSES.map(function (s) { return '<option value="' + s + '"' + (s === t.status ? ' selected' : '') + '>' + TAB_LABELS[s] + '</option>'; }).join('')
        + '</select>', c, 'pill') + (t.overdue ? '<span style="font-size:12px; font-weight:600; color:' + c.error + ';">' + T('Overdue') + '</span>' : '')
      : '<span style="display:inline-flex; align-items:center; padding:4px 10px; border-radius:var(--r-sm); background:' + v.statusBg + '; color:' + v.statusColor + '; font-size:12px; font-weight:600;">' + v.statusLabel + '</span>';

    var chip = function (inner) { return '<span style="display:inline-flex; align-items:center; gap:6px; font-size:13px; color:' + c.onSurfaceVariant + ';">' + inner + '</span>'; };
    var meta = [
      statusControl,
      chip('<span style="width:7px; height:7px; border-radius:50%; background:' + v.priorityColor + ';"></span>' + esc(T(t.priority))),
      chip('<span style="color:' + v.dueColor + '; font-weight:' + v.dueWeight + ';">' + esc(t.dueDate ? T('Due {date}', { date: formatDue(t.dueDate) }) : T('No due date')) + '</span>' + (t.recurrence ? ICON.repeat + esc(describeRepeat(t.recurrence)) : '')),
      chip(assigneeAvatarHtml(t, v, 20) + esc(t.assignee)),
      t.deptId ? chip(esc(nodeLabel(t.deptId))) : '',
      t.calendarVisible ? chip(v.syncIcon + T('In calendar')) : ''
    ].filter(Boolean).join('<span style="width:1px; height:14px; background:' + c.outlineVariant + ';"></span>');

    var closing = state.detailPhase === 'closing';
    var mo = modalMotion('detail', closing);
    return '<div class="modal-overlay ' + mo.dim + '" data-backdrop="closeTaskDetail" style="' + mo.dimStyle + 'position:fixed; background:rgba(0,0,0,.4); display:flex; align-items:center; justify-content:center; z-index:50;">'
      + '<div role="dialog" id="taskDetailDialog" data-scroll-key="' + esc('detail:' + t.id) + '" aria-modal="true" aria-label="' + esc(t.title) + '" tabindex="-1" class="task-detail ' + mo.card + (state.dragOver ? ' drag-over' : '') + '" style="' + mo.cardStyle + 'background:' + c.surface + '; --drop:' + c.primary + ';">'
      +   '<div style="display:flex; align-items:center; gap:10px;">'
      +     '<div style="flex:1; min-width:0; display:flex; align-items:center; gap:10px; position:relative;">'
      +       iconBlock
      +       ((state.iconPickerOpen || state.iconPickerClosing) && writable ? iconPicker(c, t) : '')
      +       '<h2 style="flex:1; min-width:0; margin:0; font-size:24px; line-height:1.3; font-weight:600; overflow-wrap:anywhere; color:' + v.titleColor + '; text-decoration:' + v.titleDeco + ';">' + esc(t.title) + '</h2>'
      +     '</div>'
      +     (writable ? '<span class="interactive" data-action="editFromDetail" title="' + T('Edit task') + '" style="display:flex; align-items:center; justify-content:center; width:36px; height:36px; border-radius:50%; flex-shrink:0; color:' + c.onSurfaceVariant + '; background:' + c.surfaceContainerHigh + ';">' + gear + '</span>' : '')
      +     '<span class="interactive" data-action="closeTaskDetail" title="' + T('Close') + '" style="display:flex; align-items:center; justify-content:center; width:36px; height:36px; border-radius:50%; flex-shrink:0; color:' + c.onSurfaceVariant + ';">' + ICON.close + '</span>'
      +   '</div>'
      +   '<div style="display:flex; align-items:center; flex-wrap:wrap; gap:8px 12px;">' + meta + '</div>'
      +   (writable ? '' : '<div style="font-size:12px; line-height:1.45; color:' + c.onSurfaceVariant + '; background:' + c.surfaceContainerHigh + '; padding:8px 11px; border-radius:var(--r-sm);">This task belongs to ' + esc(nodeLabel(t.deptId) || 'no department') + ', so you can read and comment on it but not change it.</div>')
      +   '<div class="detail-body" style="color:' + (t.description ? c.onSurface : c.onSurfaceVariant) + ';">' + (t.description ? linkify(t.description) : T('No description.')) + '</div>'
      +   '<div style="height:1px; background:' + c.outlineVariant + ';"></div>'
      +   checklistSection(c, true, !writable)
      +   attachmentsSection(c, writable)
      +   commentThread(c)
      +   '<div style="font-size:12px; color:' + c.onSurfaceVariant + ';">' + (t.createdByName ? esc(T('Created by {name}', { name: t.createdByName })) + ' &middot; ' : '') + esc(T('updated {when}', { when: formatStamp(t.updatedAt) })) + '</div>'
      + '</div></div>';
  }

  // Descriptions are plain text; web addresses in them become links that
  // open in a new tab.
  function linkify(text) {
    return esc(text).replace(/\bhttps?:\/\/[^\s<>"']+/g, function (url) {
      var trail = '';
      var m = /[.,;:!?)\]]+$/.exec(url);
      if (m) { trail = m[0]; url = url.slice(0, -trail.length); }
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>' + trail;
    });
  }

  function iconPicker(c, t) {
    var tabs = TASK_EMOJI_GROUPS.map(function (g, i) {
      return '<span class="interactive emoji-tab" data-action="jumpToEmojiGroup" data-id="' + i + '" title="' + T(g[0]) + '">' + g[1][0] + '</span>';
    }).join('');
    var grid = TASK_EMOJI_GROUPS.map(function (g, gi) {
      return '<div class="emoji-group-head" id="emoji-group-' + gi + '" style="color:' + c.onSurfaceVariant + ';">' + T(g[0]) + '</div>'
        + g[1].map(function (e) {
            var i = TASK_EMOJIS.indexOf(e);
            return '<span class="interactive emoji-cell' + (t.icon === e ? ' selected' : '') + '" data-action="pickTaskEmoji" data-id="' + i + '" aria-label="' + e + '">' + e + '</span>';
          }).join('');
    }).join('');
    var closing = state.iconPickerClosing;
    var enter = motion('icon:in', !closing, 'dropdown-in', 285);
    var exit = motion('icon:out', closing, 'dropdown-out', ICON_PICKER_OUT_MS, true);
    var m = closing ? exit : enter;
    return '<div class="icon-picker ' + m.cls + '" data-dropdown="icon" style="' + m.style + 'background:' + c.surface + '; border:1px solid ' + c.outlineVariant + ';">'
      + '<div style="display:flex; align-items:center; gap:10px; padding:2px 4px 8px 4px;">'
      +   '<span style="font-size:12px; font-weight:600; flex:1;">' + T('Icon') + '</span>'
      +   '<span class="interactive" data-action="uploadTaskIcon" style="font-size:12px; font-weight:600; color:' + c.primary + ';">' + T('Upload image') + '</span>'
      +   (t.icon ? '<span class="interactive" data-action="removeTaskIcon" style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Remove') + '</span>' : '')
      + '</div>'
      + '<div class="emoji-tabs" style="border-bottom:1px solid ' + c.outlineVariant + ';">' + tabs + '</div>'
      + '<div class="emoji-grid" data-scroll-key="emoji-grid">' + grid + '</div>'
      + '</div>';
  }

  function fileIcon() {
    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M5 2.5h6.5L15.5 6.5v11H5z"></path><path d="M11.5 2.5v4h4"></path></svg>';
  }

  function attachmentsSection(c, writable) {
    var images = state.attachments.filter(function (a) { return a.isImage; });
    var files = state.attachments.filter(function (a) { return !a.isImage; });
    var del = function (a) {
      return writable ? '<span class="interactive att-remove" data-action="deleteAttachment" data-id="' + a.id + '" title="' + esc(T('Remove {name}', { name: a.name })) + '" style="background:' + c.surface + '; color:' + c.onSurfaceVariant + ';">' + ICON.close + '</span>' : '';
    };
    var tiles = images.map(function (a) {
      return '<div class="att-tile' + oneShotClass('att:' + a.id) + '" style="border:1px solid ' + c.outlineVariant + ';">'
        + '<img class="interactive" data-action="openLightbox" data-id="' + a.id + '" src="/api/attachments/' + a.id + '" alt="' + esc(a.name) + '" loading="lazy">'
        + del(a)
        + '</div>';
    }).join('');
    var rows = files.map(function (a) {
      return '<div class="att-row' + oneShotClass('att:' + a.id) + '" style="border:1px solid ' + c.outlineVariant + ';">'
        + '<span style="color:' + c.primary + '; display:flex;">' + fileIcon() + '</span>'
        + '<a href="/api/attachments/' + a.id + '?download=1" download="' + esc(a.name) + '" style="flex:1; min-width:0; color:' + c.onSurface + '; text-decoration:none;">'
        +   '<div style="font-size:13px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(a.name) + '</div>'
        +   '<div style="font-size:12px; color:' + c.onSurfaceVariant + ';">' + formatBytes(a.size) + ' &middot; ' + esc(a.uploaderName) + ' &middot; ' + esc(formatStamp(a.createdAt)) + '</div>'
        + '</a>'
        + del(a)
        + '</div>';
    }).join('');
    var busy = state.uploading > 0 ? '<span style="font-size:12px; color:' + c.onSurfaceVariant + ';">' + T(state.uploading === 1 ? 'Uploading {n} file…' : 'Uploading {n} files…', { n: state.uploading }) + '</span>' : '';
    return '<div style="display:flex; flex-direction:column; gap:8px;">'
      + '<div style="display:flex; align-items:center; gap:10px;">'
      +   '<label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Attachments') + (state.attachments.length ? ' (' + state.attachments.length + ')' : '') + '</label>'
      +   busy
      +   (writable ? '<span class="interactive" data-action="pickAttachments" style="margin-left:auto; font-size:13px; font-weight:600; color:' + c.primary + ';">' + T('+ Add files') + '</span>' : '')
      + '</div>'
      + (tiles ? '<div class="att-grid">' + tiles + '</div>' : '')
      + rows
      + (!state.attachments.length
          ? '<div style="font-size:12px; color:' + c.onSurfaceVariant + ';">' + (writable ? T('No files yet. Drop files here, paste an image, or use Add files (up to 20 MB each).') : T('No files.')) + '</div>'
          : '')
      + '</div>';
  }

  function lightbox(c) {
    var a = state.lightbox;
    if (!a) return '';
    return '<div class="lightbox" role="dialog" aria-modal="true" aria-label="' + esc(a.name) + '" data-action="closeLightbox">'
      + '<img src="/api/attachments/' + a.id + '" alt="' + esc(a.name) + '">'
      + '<div class="lightbox-bar">'
      +   '<span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(a.name) + ' &middot; ' + formatBytes(a.size) + '</span>'
      +   '<a href="/api/attachments/' + a.id + '?download=1" download="' + esc(a.name) + '" style="color:#fff; font-weight:600; text-decoration:none;">' + T('Download') + '</a>'
      +   '<span class="interactive" data-action="closeLightbox" title="' + T('Close') + '" style="display:flex; align-items:center; justify-content:center; width:30px; height:30px; border-radius:50%;">' + ICON.close + '</span>'
      + '</div>'
      + '</div>';
  }

  // ---- passwords ----
  function passwordFields(c, forced) {
    var f = state.pwForm;
    var field = function (id, key, label, value, auto) {
      label = T(label);
      return '<div style="display:flex; flex-direction:column; gap:5px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + label + '</label>'
        + '<input id="' + id + '" type="password" data-form="pwForm" data-field="' + key + '" value="' + esc(value) + '" autocomplete="' + auto + '" style="height:40px; padding:0 12px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:14px; background:' + c.surface + '; color:' + c.onSurface + ';"></input></div>';
    };
    return field('pwCurrentInput', 'current', forced ? 'Temporary password' : 'Current password', f.current, 'current-password')
      + field('pwNewInput', 'next', 'New password (at least 8 characters)', f.next, 'new-password')
      + field('pwConfirmInput', 'confirm', 'New password again', f.confirm, 'new-password')
      + (state.pwError ? '<div role="alert" style="font-size:13px; color:' + c.error + ';">' + esc(state.pwError) + '</div>' : '');
  }

  function passwordModal(c) {
    if (state.passwordModalPhase === 'closed') return '';
    return modalShell('password', state.passwordModalPhase, c, 'Change password', 400,
      '<span style="font-size:18px; font-weight:600;">' + T('Change password') + '</span>'
      + '<div style="font-size:12px; line-height:1.5; color:' + c.onSurfaceVariant + ';">' + T('Your other sign-ins - other browsers and phones using this password - are signed out. App passwords for phone sync keep working.') + '</div>'
      + passwordFields(c, false)
      + '<div style="display:flex; justify-content:flex-end; gap:8px; margin-top:4px;">' + pillButton('closePasswordModal', 'Cancel', c, false) + pillButton('submitPasswordChange', 'Change password', c, true) + '</div>');
  }

  // After an administrator's reset, the temporary password only gets as far
  // as this: nothing else loads until a password of their own is set.
  function PasswordScreen() {
    var c = deriveColors(state.accent, isDarkActive());
    var vars = Object.keys(c).map(function (k) { return '--' + k.replace(/([A-Z])/g, '-$1').toLowerCase() + ':' + c[k] + ';'; }).join('');
    try { document.body.style.background = c.surfaceContainerLow; } catch (e) {}
    try { document.documentElement.setAttribute('data-theme', c.dark ? 'dark' : 'light'); } catch (e) {}
    return '<div style="' + vars + 'min-height:100vh; display:flex; align-items:center; justify-content:center; background:' + c.surfaceContainerLow + '; color:' + c.onSurface + ';">'
      + '<div class="auth-card" role="dialog" aria-label="' + T('Choose a new password') + '" style="width:400px; max-width:92vw; background:' + c.surface + '; border-radius:var(--r-lg); padding:30px; box-shadow:var(--e2); display:flex; flex-direction:column; gap:14px;">'
      +   '<div style="display:flex; align-items:center; gap:10px;">' + brandIconHtml(c.primaryContainer, c.onPrimaryContainer, 36, false) + '<div style="font-size:18px; font-weight:600;">' + T('Choose a new password') + '</div></div>'
      +   '<div style="font-size:13px; line-height:1.5; color:' + c.onSurfaceVariant + ';">' + T('An administrator reset the password for {name}. Enter the temporary password you were given, then one of your own.', { name: '<b>' + esc(state.user.displayName) + '</b>' }) + '</div>'
      +   passwordFields(c, true)
      +   '<div class="interactive" data-action="submitPasswordChange" style="height:44px; border-radius:var(--r-sm); background:' + c.primary + '; color:' + c.onPrimary + '; display:flex; align-items:center; justify-content:center; font-weight:600; font-size:14px;">' + T('Set password') + '</div>'
      +   '<div class="interactive" data-action="logout" style="text-align:center; font-size:13px; color:' + c.onSurfaceVariant + ';">' + T('Log out') + '</div>'
      + '</div></div>';
  }

  var BACKDROP_CLOSERS = { trash: 'closeTrash', appPasswords: 'closeAppPasswords', backups: 'closeBackups', reminders: 'closeReminders', password: 'closePasswordModal' };

  function modalShell(name, phase, c, label, width, inner) {
    var mo = modalMotion(name, phase === 'closing');
    return '<div class="modal-overlay ' + mo.dim + '" data-backdrop="' + BACKDROP_CLOSERS[name] + '" style="' + mo.dimStyle + 'position:fixed; background:rgba(0,0,0,.4); display:flex; align-items:center; justify-content:center; z-index:50;">'
      + '<div role="dialog" data-scroll-key="' + name + '" aria-modal="true" aria-label="' + esc(T(label)) + '" tabindex="-1" class="' + mo.card + '" style="' + mo.cardStyle + 'width:' + width + 'px; max-width:94vw; max-height:88vh; overflow-y:auto; background:' + c.surface + '; border-radius:var(--r-lg); padding:24px; display:flex; flex-direction:column; gap:12px; box-shadow:var(--e3);">'
      + inner
      + '</div></div>';
  }

  function pillButton(action, label, c, primary, extra) {
    label = T(label);
    return '<div class="interactive" data-action="' + action + '"' + (extra || '') + ' style="display:flex; align-items:center; justify-content:center; height:38px; padding:0 18px; border-radius:var(--r-sm); font-size:13px; font-weight:600; flex-shrink:0; '
      + (primary ? 'background:' + c.primary + '; color:' + c.onPrimary + ';' : 'color:' + c.onSurfaceVariant + ';') + '">' + label + '</div>';
  }

  function trashModal(c) {
    if (state.trashModalPhase === 'closed') return '';
    var rows = state.trash.map(function (t) {
      return '<div class="' + oneShotClass('trashLeave:' + t.id).trim() + '" style="display:flex; align-items:center; gap:12px; padding:11px 0; border-bottom:1px solid ' + c.outlineVariant + ';">'
        + '<div style="flex:1; min-width:0;">'
        +   '<div style="font-size:14px; font-weight:500; overflow-wrap:anywhere;">' + esc(t.title) + '</div>'
        +   '<div style="font-size:12px; color:' + c.onSurfaceVariant + '; margin-top:2px;">'
        +     esc(t.deptId ? nodeLabel(t.deptId) : T('No department')) + ' &middot; ' + esc(t.deletedByName ? T('deleted {when} by {name}', { when: formatStamp(t.deletedAt), name: t.deletedByName }) : T('deleted {when}', { when: formatStamp(t.deletedAt) }))
        +     ' &middot; <span style="color:' + c.tertiary + '; font-weight:500;">' + esc(daysLeft(t.purgeAt)) + '</span>'
        +   '</div>'
        + '</div>'
        + (t.canRestore
          ? '<span class="interactive" data-action="restoreTrashed" data-id="' + t.id + '" style="font-size:13px; font-weight:600; color:' + c.primary + '; padding:6px;">' + T('Restore') + '</span>'
            + '<span class="interactive" data-action="purgeTrashed" data-id="' + t.id + '" title="' + T('Delete for good') + '" style="font-size:13px; font-weight:500; color:' + c.error + '; padding:6px;">' + T('Delete') + '</span>'
          : '<span style="font-size:12px; color:' + c.onSurfaceVariant + ';">' + T('Another department') + '</span>')
        + '</div>';
    }).join('');
    var anyRestorable = state.trash.some(function (t) { return t.canRestore; });
    return modalShell('trash', state.trashModalPhase, c, 'Trash', 520,
      '<span style="font-size:18px; font-weight:600;">' + T('Trash') + '</span>'
      + '<div style="font-size:12px; line-height:1.5; color:' + c.onSurfaceVariant + ';">' + T('Deleted tasks wait here for 10 days, with their comments and checklist, and are then removed for good. Restoring one puts it back where it was.') + '</div>'
      + (state.trash.length ? rows : '<div style="font-size:13px; color:' + c.onSurfaceVariant + '; padding:18px 0;">' + T('The trash is empty.') + '</div>')
      + '<div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:6px;">'
      +   (anyRestorable ? '<span class="interactive" data-action="emptyTrash" style="font-size:13px; font-weight:500; color:' + c.error + '; padding:8px 6px;">' + T('Empty trash') + '</span>' : '<span></span>')
      +   pillButton('closeTrash', 'Done', c, true)
      + '</div>');
  }

  function appPasswordsModal(c) {
    if (state.appPwModalPhase === 'closed') return '';
    var code = function (v) { return '<code style="font-size:12px; padding:2px 7px; border-radius:var(--r-sm); background:' + c.surfaceContainerHigh + '; color:' + c.onSurface + ';">' + esc(v) + '</code>'; };
    var created = state.appPwCreated;
    var createdBox = created
      ? '<div class="' + oneShotClass('appPwNew').trim() + '" style="display:flex; flex-direction:column; gap:8px; padding:14px; border-radius:var(--r-md); background:' + c.primaryContainer + '; color:' + c.onPrimaryContainer + ';">'
        + '<div style="font-size:13px; font-weight:600;">App password for ' + esc(created.name) + '</div>'
        + '<div style="display:flex; align-items:center; gap:8px;"><code style="flex:1; font-size:18px; letter-spacing:.06em; font-weight:600; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap:anywhere;">' + esc(created.token) + '</code>'
        +   '<span class="interactive" data-action="copyAppPassword" title="' + T('Copy') + '" style="display:flex; align-items:center; justify-content:center; width:30px; height:30px; border-radius:var(--r-sm);">' + (state.copiedToken === 'app-pw' ? '<span class="anim-copied" style="display:flex;">' + ICON.check + '</span>' : ICON.copy) + '</span></div>'
        + '<div style="font-size:12px; line-height:1.45;">' + T('Enter it as the password on the device now. It is shown only this once - if you lose it, revoke it and make another.') + '</div>'
        + '</div>'
      : '';
    var rows = state.appPasswords.map(function (p) {
      return '<div style="display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid ' + c.outlineVariant + ';">'
        + '<div style="flex:1; min-width:0;"><div style="font-size:13px; font-weight:500;">' + esc(p.name) + '</div>'
        + '<div style="font-size:12px; color:' + c.onSurfaceVariant + '; margin-top:2px;">' + esc(T('Created {when}', { when: formatStamp(p.createdAt) })) + ' &middot; ' + esc(p.lastUsedAt ? T('last synced {when}', { when: formatStamp(p.lastUsedAt) }) : T('never used yet')) + '</div></div>'
        + '<span class="interactive" data-action="revokeAppPassword" data-id="' + p.id + '" style="font-size:13px; font-weight:500; color:' + c.error + '; padding:6px;">' + T('Revoke') + '</span>'
        + '</div>';
    }).join('');
    return modalShell('appPasswords', state.appPwModalPhase, c, 'Phone sync', 480,
      '<span style="font-size:18px; font-weight:600;">' + T('Phone sync') + '</span>'
      + '<div style="font-size:12px; line-height:1.55; color:' + c.onSurfaceVariant + ';">' + T('A phone’s reminders app signs in with a CalDAV account. Give each device its own {term} instead of your real one: if a phone is lost, revoke its line here and nothing else changes.', { term: '<b>' + T('app password') + '</b>' }) + '</div>'
      + '<table class="guide-table" style="font-size:13px;">'
      +   '<tr><th style="color:' + c.onSurfaceVariant + ';">' + T('Server') + '</th><td>' + code(location.origin + '/caldav/') + '</td></tr>'
      +   '<tr><th style="color:' + c.onSurfaceVariant + ';">' + T('User name') + '</th><td>' + code(state.user.username) + '</td></tr>'
      +   '<tr><th style="color:' + c.onSurfaceVariant + ';">' + T('Password') + '</th><td>' + T('an app password from below') + '</td></tr>'
      + '</table>'
      + createdBox
      + '<div style="display:flex; gap:8px; align-items:center;">'
      +   '<input id="appPwNameInput" data-field="appPwName" value="' + esc(state.appPwName) + '" maxlength="60" placeholder="' + T('Device name, e.g. iPhone') + '" style="flex:1; min-width:0; height:38px; padding:0 12px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:13px; background:' + c.surface + '; color:' + c.onSurface + ';"></input>'
      +   pillButton('createAppPassword', 'Create', c, true)
      + '</div>'
      + '<div style="font-size:13px; font-weight:600; margin-top:6px;">' + T('Your devices') + '</div>'
      + (state.appPasswords.length ? rows : '<div style="font-size:12px; color:' + c.onSurfaceVariant + ';">' + T('No app passwords yet.') + '</div>')
      + '<div style="display:flex; justify-content:flex-end; margin-top:6px;">' + pillButton('closeAppPasswords', 'Done', c, true) + '</div>');
  }

  function remindersModal(c) {
    if (state.reminderModalPhase === 'closed') return '';
    var r = state.reminders;
    var f = state.reminderForm;
    var field = 'height:36px; padding:0 10px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:13px; background:' + c.surface + '; color:' + c.onSurface + ';';
    return modalShell('reminders', state.reminderModalPhase, c, 'Due-date reminders', 460,
      '<span style="font-size:18px; font-weight:600;">' + T('Due-date reminders') + '</span>'
      + '<div style="font-size:12px; line-height:1.5; color:' + c.onSurfaceVariant + ';">' + T('Once a day the server tells each person, in their notifications, which of their unfinished tasks are due today and which are due tomorrow. Tasks with nobody assigned are left out.') + '</div>'
      + '<label class="interactive" style="display:flex; align-items:center; gap:9px; font-size:14px; font-weight:500; cursor:pointer;"><input type="checkbox" id="reminderEnabledInput"' + (f.enabled ? ' checked' : '') + '></input>' + T('Send due-date reminders every day') + '</label>'
      + '<div style="display:flex; flex-direction:column; gap:4px; opacity:' + (f.enabled ? '1' : '.5') + ';"><span style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Time') + '</span>'
      +   '<input id="reminderTimeInput" type="time" value="' + esc(f.time) + '" style="width:140px; ' + field + '"></input></div>'
      + (r ? '<div style="font-size:12px; line-height:1.5; color:' + c.onSurfaceVariant + ';">' + esc(T('The server’s clock reads {time} ({zone}) right now. If the server was off at the set time, that day’s reminders go out as soon as it starts.', { time: r.serverTime, zone: r.serverZone }))
          + (r.enabled && r.nextAt ? '<br>' + esc(T('Next reminders {when}', { when: formatStamp(r.nextAt) })) : '') + '</div>' : '')
      + '<div style="display:flex; gap:8px; justify-content:flex-end; margin-top:4px;">' + pillButton('closeReminders', 'Cancel', c, false) + pillButton('saveReminderSettings', 'Save', c, true) + '</div>');
  }

  function backupsModal(c) {
    if (state.backupModalPhase === 'closed') return '';
    var b = state.backups;
    var f = state.backupForm;
    var field = 'height:36px; padding:0 10px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:13px; background:' + c.surface + '; color:' + c.onSurface + ';';
    var status = '';
    if (b) {
      var lines = [];
      if (b.lastAt) lines.push(esc(T('Last backup {when}', { when: formatStamp(b.lastAt) })) + ' &middot; <code>' + esc(b.lastFile) + '</code>');
      else lines.push('No backup has been made yet.');
      if (b.lastError) lines.push('<span style="color:' + c.error + ';">' + esc(b.lastErrorAt ? T('Last attempt failed {when}', { when: formatStamp(b.lastErrorAt) }) : T('Last attempt failed')) + ': ' + esc(b.lastError) + '</span>');
      if (b.enabled && b.nextAt) lines.push(esc(T('Next backup {when}', { when: formatStamp(b.nextAt) })));
      status = '<div style="display:flex; flex-direction:column; gap:4px; font-size:12px; line-height:1.5; color:' + c.onSurfaceVariant + '; padding:10px 12px; border-radius:var(--r-sm); background:' + c.surfaceContainerLow + ';">' + lines.map(function (l) { return '<div>' + l + '</div>'; }).join('') + '</div>';
    }
    var files = b && b.files && b.files.length
      ? b.files.map(function (fl) {
          return '<div style="display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid ' + c.outlineVariant + '; font-size:13px;">'
            + '<code style="flex:1; min-width:0; overflow-wrap:anywhere; font-size:12px;">' + esc(fl.name) + '</code>'
            + '<span style="color:' + c.onSurfaceVariant + '; font-size:12px; white-space:nowrap;">' + formatBytes(fl.size) + '</span>'
            + '<a href="/api/backups/' + encodeURIComponent(fl.name) + '" download style="font-size:12px; font-weight:600; color:' + c.primary + '; text-decoration:none;">' + T('Download') + '</a>'
            + '</div>';
        }).join('')
      : '<div style="font-size:12px; color:' + c.onSurfaceVariant + ';">' + T('No backups in the folder yet.') + '</div>';
    return modalShell('backups', state.backupModalPhase, c, 'Backups', 520,
      '<span style="font-size:18px; font-weight:600;">' + T('Backups') + '</span>'
      + '<div style="font-size:12px; line-height:1.5; color:' + c.onSurfaceVariant + ';">' + T('A consistent copy of the whole database, taken while the server keeps running. Backups go to {dir} on the server (set with {flag}). Download one now and then so a copy lives off that machine too.', { dir: b ? '<code style="overflow-wrap:anywhere;">' + esc(b.dir) + '</code>' : T('the backups folder'), flag: '<code>-backup-dir</code>' }) + '</div>'
      + (b && b.attachmentsCount ? '<div style="font-size:12px; color:' + c.onSurfaceVariant + ';">' + T(b.attachmentsCount === 1 ? 'Task attachments take {size} ({n} file), kept as files in {dir}. Backups keep one copy of each file, shared between them, and a download is a zip of the database with its files.' : 'Task attachments take {size} ({n} files), kept as files in {dir}. Backups keep one copy of each file, shared between them, and a download is a zip of the database with its files.', { size: formatBytes(b.attachmentsBytes), n: b.attachmentsCount, dir: '<code style="overflow-wrap:anywhere;">' + esc(b.attachmentsDir || 'attachments') + '</code>' }) + '</div>' : '')
      + '<label class="interactive" style="display:flex; align-items:center; gap:9px; font-size:14px; font-weight:500; cursor:pointer;"><input type="checkbox" id="backupEnabledInput"' + (f.enabled ? ' checked' : '') + '></input>' + T('Back up automatically every day') + '</label>'
      + '<div style="display:flex; gap:12px; flex-wrap:wrap; opacity:' + (f.enabled ? '1' : '.55') + ';">'
      +   '<div style="display:flex; flex-direction:column; gap:5px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Time (server clock)') + '</label>'
      +     '<input id="backupTimeInput" type="time" value="' + esc(f.time) + '" style="' + field + '"></input></div>'
      +   '<div style="display:flex; flex-direction:column; gap:5px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Keep the newest') + '</label>'
      +     '<div style="display:flex; align-items:center; gap:6px;"><input id="backupKeepInput" type="number" min="1" max="365" value="' + esc(f.keep) + '" style="width:76px; ' + field + '"></input><span style="font-size:12px; color:' + c.onSurfaceVariant + ';">' + T('backups') + '</span></div></div>'
      + '</div>'
      + (b ? '<div style="font-size:12px; color:' + c.onSurfaceVariant + '; margin-top:-4px;">' + esc(T('The server’s clock reads {time} ({zone}) right now. If the server was off at the set time, that day’s backup runs as soon as it starts.', { time: b.serverTime, zone: b.serverZone })) + '</div>' : '')
      + '<div style="display:flex; gap:8px; justify-content:flex-end;">' + pillButton('saveBackupSettings', 'Save schedule', c, true) + '</div>'
      + status
      + '<div style="display:flex; align-items:center; justify-content:space-between; margin-top:4px;"><span style="font-size:13px; font-weight:600;">' + T('Backup files') + '</span>'
      +   '<span class="interactive" data-action="runBackup" style="font-size:13px; font-weight:600; color:' + c.primary + '; opacity:' + (state.backupBusy ? '.5' : '1') + ';">' + (state.backupBusy ? T('Backing up…') : T('Back up now')) + '</span></div>'
      + '<div data-scroll-key="backup-files" style="max-height:220px; overflow-y:auto;">' + files + '</div>'
      + '<div style="display:flex; justify-content:flex-end; margin-top:6px;">' + pillButton('closeBackups', 'Done', c, false) + '</div>');
  }

  function snackbar(c) {
    var sb = state.snackbar;
    if (!sb) return '';
    var m = motion('snack:' + sb.id + (sb.closing ? ':out' : ':in'), true, sb.closing ? 'snack-out' : 'snack-in', sb.closing ? 220 : 300, sb.closing);
    return '<div class="snackbar ' + m.cls + '" role="status" aria-live="polite" style="' + m.style + 'background:' + c.onSurface + '; color:' + c.surface + ';">'
      + '<span style="flex:1; min-width:0;">' + esc(sb.text) + '</span>'
      + (sb.action ? '<span class="interactive" data-action="snackbarAction" style="font-weight:600; color:' + c.primaryContainer + '; padding:4px 6px; flex-shrink:0;">' + T('Undo') + '</span>' : '')
      + '<span class="interactive" data-action="dismissSnackbar" title="' + T('Dismiss') + '" style="display:flex; align-items:center; justify-content:center; width:24px; height:24px; border-radius:50%; flex-shrink:0; opacity:.8;">' + ICON.close + '</span>'
      + '</div>';
  }

  function addDeptModal(c) {
    if (state.addDeptModalPhase === 'closed') return '';
    var closing = state.addDeptModalPhase === 'closing';
    var mo = modalMotion('addDept', closing);
    var f = state.newDeptForm;
    var parentOptions = buildDeptTree().map(function (d) {
      return '<option value="' + esc(d.id) + '"' + (d.id === f.parentId ? ' selected' : '') + '>' + esc(d.name) + '</option>';
    }).join('');

    return '<div class="modal-overlay ' + mo.dim + '" data-backdrop="closeAddDept" style="' + mo.dimStyle + 'position:fixed; background:rgba(0,0,0,.4); display:flex; align-items:center; justify-content:center; z-index:50;">'
      + '<div role="dialog" aria-modal="true" aria-label="' + esc(T('Add Department')) + '" tabindex="-1" class="' + mo.card + '" style="' + mo.cardStyle + 'width:380px; max-width:92vw; background:' + c.surface + '; border-radius:var(--r-lg); padding:24px; display:flex; flex-direction:column; gap:14px; box-shadow:var(--e3);">'
      +   '<span style="font-size:18px; font-weight:600;">' + T('Add Department') + '</span>'
      +   '<div style="display:flex; flex-direction:column; gap:5px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Name') + '</label>'
      +     '<input id="newDeptNameInput" data-form="newDeptForm" data-field="name" value="' + esc(f.name) + '" placeholder="' + T('e.g. Data Team') + '" style="height:38px; padding:0 12px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:14px; background:' + c.surface + '; color:' + c.onSurface + ';"></input></div>'
      +   '<div style="display:flex; flex-direction:column; gap:5px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Parent Department') + '</label>'
      +     mSelectFrom('<select id="newDeptParentSelect" data-form="newDeptForm" data-field="parentId" style="height:38px; padding:0 10px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:14px; background:' + c.surface + '; color:' + c.onSurface + ';">'
      +       '<option value=""' + (f.parentId === '' ? ' selected' : '') + '>&mdash; ' + T('Top level') + ' &mdash;</option>' + parentOptions
      +     '</select>', c) + '</div>'
      +   '<div style="display:flex; justify-content:flex-end; gap:10px; margin-top:6px;">'
      +     '<div class="interactive" data-action="closeAddDept" style="display:flex; align-items:center; justify-content:center; height:40px; padding:0 18px; border-radius:var(--r-sm); color:' + c.onSurfaceVariant + '; font-size:14px; font-weight:500;">' + T('Cancel') + '</div>'
      +     '<div class="interactive" data-action="createDept" style="display:flex; align-items:center; justify-content:center; height:40px; padding:0 20px; border-radius:var(--r-sm); background:' + c.primary + '; color:' + c.onPrimary + '; font-size:14px; font-weight:600;">' + T('Create') + '</div>'
      +   '</div>'
      + '</div></div>';
  }

  function mappingModal(c) {
    if (state.mappingModalPhase === 'closed') return '';
    var closing = state.mappingModalPhase === 'closing';
    var mo = modalMotion('mapping', closing);
    var f = state.mappingForm;
    var opts = flattenDeptOptions().map(function (o) {
      return '<option value="' + esc(o.id) + '"' + (o.id === f.deptId ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('');

    return '<div class="modal-overlay ' + mo.dim + '" data-backdrop="closeMapping" style="' + mo.dimStyle + 'position:fixed; background:rgba(0,0,0,.4); display:flex; align-items:center; justify-content:center; z-index:50;">'
      + '<div role="dialog" aria-modal="true" aria-label="' + esc(T('Department settings')) + '" tabindex="-1" class="' + mo.card + '" style="' + mo.cardStyle + 'width:380px; max-width:92vw; background:' + c.surface + '; border-radius:var(--r-lg); padding:24px; display:flex; flex-direction:column; gap:14px; box-shadow:var(--e3);">'
      +   '<span style="font-size:18px; font-weight:600;">' + T('Department') + '</span>'
      +   '<div style="display:flex; flex-direction:column; gap:5px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Department') + '</label>'
      +     mSelectFrom('<select id="mappingDeptSelect" data-form="mappingForm" data-field="deptId" style="height:38px; padding:0 10px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:14px; background:' + c.surface + '; color:' + c.onSurface + ';"><option value="">' + T('— Select —') + '</option>' + opts + '</select>', c) + '</div>'
      +   (f.deptId ? '<div style="display:flex; flex-direction:column; gap:5px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Name') + '</label>'
      +     '<input id="mappingNameInput" data-form="mappingForm" data-field="name" value="' + esc(f.name) + '" maxlength="60" style="height:38px; padding:0 12px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:14px; background:' + c.surface + '; color:' + c.onSurface + ';"></input></div>' : '')
      +   '<div style="font-size:12px; line-height:1.5; color:' + c.onSurfaceVariant + ';">' + T('The calendar label below is only for your own reference in the sidebar — the subscribe link works either way.') + '</div>'
      +   '<div style="display:flex; flex-direction:column; gap:5px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Calendar List Name') + '</label>'
      +     '<input id="mappingListInput" data-form="mappingForm" data-field="calendarList" value="' + esc(f.calendarList) + '" placeholder="' + T('e.g. Work / Dev-Backend') + '" style="height:38px; padding:0 12px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:14px; background:' + c.surface + '; color:' + c.onSurface + ';"></input></div>'
      +   '<div style="display:flex; flex-direction:column; gap:5px;"><label style="font-size:12px; font-weight:500; color:' + c.onSurfaceVariant + ';">' + T('Tag') + '</label>'
      +     '<input id="mappingTagInput" data-form="mappingForm" data-field="tag" value="' + esc(f.tag) + '" placeholder="' + T('e.g. #engineering:backend') + '" style="height:38px; padding:0 12px; border-radius:var(--r-sm); border:1px solid ' + c.outline + '; font-size:14px; background:' + c.surface + '; color:' + c.onSurface + ';"></input></div>'
      +   '<div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:6px;">'
      +     (f.deptId ? '<div class="interactive" data-action="deleteDept" style="font-size:14px; font-weight:500; color:' + c.error + '; padding:8px 6px;">' + T('Delete') + '</div>' : '<span></span>')
      +     '<div style="display:flex; gap:10px;">'
      +       '<div class="interactive" data-action="closeMapping" style="display:flex; align-items:center; justify-content:center; height:40px; padding:0 18px; border-radius:var(--r-sm); color:' + c.onSurfaceVariant + '; font-size:14px; font-weight:500;">' + T('Cancel') + '</div>'
      +       '<div class="interactive" data-action="saveMapping" style="display:flex; align-items:center; justify-content:center; height:40px; padding:0 20px; border-radius:var(--r-sm); background:' + c.primary + '; color:' + c.onPrimary + '; font-size:14px; font-weight:600;">' + T('Save') + '</div>'
      +     '</div>'
      +   '</div>'
      + '</div></div>';
  }

  // ---- event delegation ----
  var ACTIONS = {
    switchAuthView: function (el) { switchAuthView(el.getAttribute('data-id')); },
    submitLogin: function () { submitLogin(); },
    submitRegister: function () { submitRegister(); },
    logout: function () { logout(); },

    selectNode: function (el) { selectNode(el.getAttribute('data-id')); },
    toggleExpand: function (el) { toggleExpand(el.getAttribute('data-id')); },
    setTab: function (el) { setTab(el.getAttribute('data-id')); },
    toggleTodayTask: function (el) { toggleTodayTask(Number(el.getAttribute('data-id'))); },
    clearSearch: function () { clearSearch(); },
    setViewMode: function (el) { setViewMode(el.getAttribute('data-id')); },
    prevPage: function () { prevPage(); },
    nextPage: function () { nextPage(); },
    clearFilters: function () { clearFilters(); },
    toggleFilterOpen: function () { toggleFilterOpen(); },
    toggleFilterPriority: function (el) { toggleFilterPriority(el.getAttribute('data-id')); },
    setFilterCalendar: function (el) { setFilterCalendar(el.getAttribute('data-id')); },
    toggleNotif: function () { toggleNotif(); },
    markNotifRead: function (el) { markNotifRead(el.getAttribute('data-id')); },
    markAllNotifsRead: function () { markAllNotifsRead(); },
    toggleAccount: function () { toggleAccount(); },
    toggleSidebar: function () { toggleSidebar(); },
    closeMobileNav: function () { closeMobileNav(); },
    toggleMobileCalendar: function () { toggleMobileCalendar(); },
    closeMobileCalendar: function () { closeMobileCalendar(); },
    closeMobileDrawers: function () { closeMobileDrawers(); },
    openMobileSearch: function () { openMobileSearch(); },
    closeMobileSearch: function () { closeMobileSearch(); },
    setAccent: function (el) { setAccent(el.getAttribute('data-hex')); },
    toggleAccentPicker: function () { toggleAccentPicker(); },
    cycleThemeMode: function () { cycleThemeMode(); },
    saveAppName: function () { saveAppName(); },
    saveDisplayName: function () { saveDisplayName(); },
    pickAppIcon: function () { closeDropdowns(); pickAppIcon(); },
    removeAppIcon: function () { closeDropdowns(); removeAppIcon(); },
    toggleBrandMenu: function () { toggleDropdown('brand'); },
    pickAvatar: function () { pickAvatar(); },
    removeAvatar: function () { removeAvatar(); },
    copyFeedUrl: function (el) { copyFeedUrl(el.getAttribute('data-id')); },
    toggleFeeds: function () { toggleFeeds(); },

    postComment: function () { postComment(); },
    deleteComment: function (el) { deleteComment(Number(el.getAttribute('data-id'))); },
    openTaskModal: function () { openTaskModal(); },
    openTask: function (el) { openTaskDetail(Number(el.getAttribute('data-id'))); },
    toggleMSelect: function (el) { toggleMSelect(el.getAttribute('data-id')); },
    pickMSelect: function (el) { pickMSelect(el.getAttribute('data-id'), el.getAttribute('data-value')); },
    closeTaskDetail: function () { closeTaskDetail(); },
    editFromDetail: function () { editFromDetail(); },
    toggleIconPicker: function () { toggleIconPicker(); },
    pickTaskEmoji: function (el) { pickTaskEmoji(Number(el.getAttribute('data-id'))); },
    jumpToEmojiGroup: function (el) { jumpToEmojiGroup(Number(el.getAttribute('data-id'))); },
    uploadTaskIcon: function () { uploadTaskIcon(); },
    removeTaskIcon: function () { removeTaskIcon(); },
    pickAttachments: function () { pickAttachments(); },
    deleteAttachment: function (el) { deleteAttachment(Number(el.getAttribute('data-id'))); },
    openLightbox: function (el) { openLightbox(Number(el.getAttribute('data-id'))); },
    closeLightbox: function () { closeLightbox(); },
    openPasswordModal: function () { openPasswordModal(); },
    closePasswordModal: function () { closePasswordModal(); },
    submitPasswordChange: function () { submitPasswordChange(); },
    resetUserPassword: function (el) { resetUserPassword(Number(el.getAttribute('data-id'))); },
    copyResetPassword: function () { if (state.resetResult) copyText(state.resetResult.temp, 'reset-pw'); },
    dismissResetResult: function () { setState({ resetResult: null }); },
    closeTaskModal: function () { closeTaskModal(); },
    saveTask: function () { saveTask(); },
    deleteTask: function () { deleteTask(); },
    toggleTaskCalendar: function () { toggleTaskCalendar(); },

    openAddDept: function () { openAddDept(); },
    closeAddDept: function () { closeAddDept(); },
    createDept: function () { createDept(); },

    openUsers: function () { openUsers(); },
    openGuide: function () { openGuide(); },
    closeGuide: function () { closeGuide(); },
    jumpToGuideSection: function (el) { jumpToGuideSection(el.getAttribute('data-id')); },
    closeUsers: function () { closeUsers(); },
    approveUser: function (el) { approveUser(Number(el.getAttribute('data-id'))); },
    setUserStatus: function (el) { setUserStatus(Number(el.getAttribute('data-id')), el.getAttribute('data-value')); },
    setUserRole: function (el) { setUserRole(Number(el.getAttribute('data-id')), el.getAttribute('data-value')); },

    setBellTab: function (el) { setBellTab(el.getAttribute('data-id')); },
    openNotification: function (el) { openNotification(Number(el.getAttribute('data-id'))); },
    toggleDesktopAlerts: function () { toggleDesktopAlerts(); },
    pickMention: function (el) { pickMention(Number(el.getAttribute('data-id'))); },

    addChecklistItem: function () { addChecklistItem(); },
    toggleChecklistItem: function (el) { toggleChecklistItem(Number(el.getAttribute('data-id'))); },
    deleteChecklistItem: function (el) { deleteChecklistItem(Number(el.getAttribute('data-id'))); },
    moveChecklistUp: function (el) { moveChecklistItem(Number(el.getAttribute('data-id')), -1); },
    moveChecklistDown: function (el) { moveChecklistItem(Number(el.getAttribute('data-id')), 1); },

    snackbarAction: function () { snackbarAction(); },
    dismissSnackbar: function () { dismissSnackbar(); },

    openTrash: function () { openTrash(); },
    closeTrash: function () { closeTrash(); },
    restoreTrashed: function (el) { restoreTrashed(Number(el.getAttribute('data-id'))); },
    purgeTrashed: function (el) { purgeTrashed(Number(el.getAttribute('data-id'))); },
    emptyTrash: function () { emptyTrash(); },

    openAppPasswords: function () { openAppPasswords(); },
    closeAppPasswords: function () { closeAppPasswords(); },
    createAppPassword: function () { createAppPassword(); },
    revokeAppPassword: function (el) { revokeAppPassword(Number(el.getAttribute('data-id'))); },
    copyAppPassword: function () { if (state.appPwCreated) copyText(state.appPwCreated.token, 'app-pw'); },

    openBackups: function () { openBackups(); },
    closeBackups: function () { closeBackups(); },
    openReminders: function () { openReminders(); },
    closeReminders: function () { closeReminders(); },
    saveReminderSettings: function () { saveReminderSettings(); },
    saveBackupSettings: function () { saveBackupSettings(); },
    runBackup: function () { runBackup(); },

    openMapping: function (el) { openMapping(el.getAttribute('data-id') || ''); },
    closeMapping: function () { closeMapping(); },
    deleteDept: function () { deleteDept(); },
    saveMapping: function () { saveMapping(); }
  };

  var backdropPressed = null;
  document.getElementById('root').addEventListener('mousedown', function (e) {
    backdropPressed = e.target && e.target.getAttribute && e.target.getAttribute('data-backdrop') ? e.target : null;
  });

  function closeFromBackdrop(action) {
    if ((action === 'closeTaskModal') && taskFormChanged() && !window.confirm(T('Discard your changes to this task?'))) return;
    var fn = ACTIONS[action];
    if (fn) fn();
  }

  document.getElementById('root').addEventListener('click', function (e) {
    var backdrop = e.target && e.target.getAttribute && e.target.getAttribute('data-backdrop');
    if (backdrop && e.target === backdropPressed) {
      backdropPressed = null;
      closeFromBackdrop(backdrop);
      return;
    }
    var el = e.target.closest('[data-action]');
    if (el) {
      var action = ACTIONS[el.getAttribute('data-action')];
      if (action) action(el);
    }
    var insideDropdown = e.target.closest('[data-dropdown]');
    if (state.openSelect && !e.target.closest('.mselect-menu') && !e.target.closest('[data-action="toggleMSelect"]')) closeMSelect();
    if (state.iconPickerOpen && !e.target.closest('[data-dropdown="icon"]') && !e.target.closest('[data-action="toggleIconPicker"]')) {
      closeIconPicker();
    }
    if (e.target.closest('.mselect-menu')) insideDropdown = true;
    if (!insideDropdown) closeDropdowns();
    if (!insideDropdown) closeAccentPicker();
  });

  document.getElementById('root').addEventListener('input', function (e) {
    var el = e.target;
    // Checked before the data-field gate below, which this input does not have.
    if (el.id === 'accentHexInput') { setAccentHex(el.value); return; }
    var form = el.getAttribute('data-form');
    var field = el.getAttribute('data-field');
    if (!field) return;
    if (form) { updateFieldSilent(form, field, el.value); return; }
    if (field === 'searchQuery') {
      state.searchQuery = el.value;
      state.page = 1;
      scheduleSearch();
      return;
    }
    state[field] = el.value;
    if (el.id === 'commentDraftInput') updateMention(el);
  });

  document.getElementById('root').addEventListener('keyup', function (e) {
    if (e.target.id !== 'commentDraftInput') return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') updateMention(e.target);
  });

  document.getElementById('root').addEventListener('change', function (e) { onControlChange(e.target); });

  function onControlChange(el) {
    // Committed when the system colour dialog closes. Applying it on every
    // drag would rebuild the input the dialog is attached to.
    if (el.id === 'accentColorInput') { applyAccent(el.value, false); return; }
    if (el.id === 'newTaskRepeatSelect') { setRepeatFreq(el.value); return; }
    if (el.id === 'detailStatusSelect') { setDetailStatus(el.value); return; }
    if (el.id === 'filterSortSelect') { setTaskSort(el.value); return; }
    if (el.id === 'filterAssigneeSelect') { setFilterAssignee(el.value); return; }
    if (el.id === 'newTaskRepeatInterval') { setRepeatInterval(el.value); return; }
    if (el.id === 'reminderEnabledInput') { setState({ reminderForm: Object.assign({}, state.reminderForm, { enabled: el.checked }) }); return; }
    if (el.id === 'reminderTimeInput') { state.reminderForm = Object.assign({}, state.reminderForm, { time: el.value }); return; }
    if (el.id === 'backupEnabledInput') { setState({ backupForm: Object.assign({}, state.backupForm, { enabled: el.checked }) }); return; }
    if (el.id === 'backupTimeInput') { state.backupForm = Object.assign({}, state.backupForm, { time: el.value }); return; }
    if (el.id === 'backupKeepInput') { state.backupForm = Object.assign({}, state.backupForm, { keep: el.value }); return; }
    if (el.tagName !== 'SELECT') return;
    var userDept = el.getAttribute('data-user-dept');
    if (userDept) { setUserDept(Number(userDept), el.value); return; }
    if (el.getAttribute('data-form') === 'mappingForm' && el.getAttribute('data-field') === 'deptId') {
      selectMappingDept(el.value);
      return;
    }
    var form = el.getAttribute('data-form');
    var field = el.getAttribute('data-field');
    if (form && field) updateField(form, field, el.value);
  }

  // A div with data-action is a button to everyone except the keyboard, which
  // sends Enter/Space and expects a click. Native controls already do this.
  document.getElementById('root').addEventListener('keydown', function (e) {
    // An open menu takes the arrows, Enter, Space and Tab; the field keeps focus.
    if (state.openSelect) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveMSelect(e.key === 'ArrowDown' ? 1 : -1); return; }
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        var ms = mselects[state.openSelect];
        var opt = ms && ms.options[state.selectIndex];
        if (opt) pickMSelect(state.openSelect, opt.value); else closeMSelect();
        return;
      }
      if (e.key === 'Tab') closeMSelect();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.getAttribute && e.target.getAttribute('data-action') === 'toggleMSelect') {
      e.preventDefault();
      openMSelect(e.target.getAttribute('data-id'));
      return;
    }
    // The @ picker takes the arrow keys, Enter and Tab while it is open.
    if (state.mention && e.target.id === 'commentDraftInput') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveMention(e.key === 'ArrowDown' ? 1 : -1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        var pick = mentionCandidates(state.mention.query)[state.mention.index];
        if (pick) { e.preventDefault(); pickMention(pick.id); return; }
      }
    }
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      var target = e.target;
      if (target && target.closest && !isNativeControl(target)) {
        var el = target.closest('[data-action]');
        if (el && !isNativeControl(el)) {
          e.preventDefault();
          var fn = ACTIONS[el.getAttribute('data-action')];
          if (fn) fn(el);
          return;
        }
      }
    }
    if (e.key === 'Escape') {
      if (dismissTopmost()) e.preventDefault();
      return;
    }
    if (e.key !== 'Enter') return;
    if (e.target.id === 'authUsername' || e.target.id === 'authPassword' || e.target.id === 'authDisplayName') {
      e.preventDefault();
      if (state.authView === 'register') submitRegister(); else submitLogin();
    }
    if (e.target.id === 'appNameInput') {
      e.preventDefault();
      saveAppName();
    }
    if (e.target.id === 'displayNameInput') {
      e.preventDefault();
      saveDisplayName();
    }
    // Enter adds the step rather than submitting the task.
    if (e.target.id === 'checklistDraftInput' && !e.isComposing) {
      e.preventDefault();
      addChecklistItem();
    }
    if (e.target.id === 'appPwNameInput') {
      e.preventDefault();
      createAppPassword();
    }
    if (e.target.id === 'pwCurrentInput' || e.target.id === 'pwNewInput' || e.target.id === 'pwConfirmInput') {
      e.preventDefault();
      submitPasswordChange();
    }
  });

  document.addEventListener('scroll', function (e) {
    if (!state.openSelect) return;
    if (e.target && e.target.closest && e.target.closest('.mselect-menu')) return;
    if (isRestoredScroll(e.target)) return;
    closeMSelect();
  }, true);
  window.addEventListener('resize', function () { if (state.openSelect) closeMSelect(); });

  function detailAcceptsFiles() {
    var t = state.detailPhase === 'open' && detailTask();
    return !!t && canWriteDept(t.deptId);
  }

  function dragHasFiles(e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
  }

  document.addEventListener('dragover', function (e) {
    if (!dragHasFiles(e) || !detailAcceptsFiles()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!state.dragOver) setState({ dragOver: true });
  });
  document.addEventListener('dragleave', function (e) {
    // Leaving for another element inside the page is not leaving.
    if (state.dragOver && !e.relatedTarget) setState({ dragOver: false });
  });
  document.addEventListener('drop', function (e) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (state.dragOver) setState({ dragOver: false });
    if (detailAcceptsFiles()) uploadAttachments(Array.prototype.slice.call(e.dataTransfer.files || []));
  });
  // A screenshot pasted while a task is open is attached to it. Pasted text
  // is left to whatever field has focus.
  document.addEventListener('paste', function (e) {
    if (!detailAcceptsFiles() || !e.clipboardData) return;
    var files = Array.prototype.slice.call(e.clipboardData.files || []);
    if (!files.length) return;
    e.preventDefault();
    uploadAttachments(files.map(function (f, i) {
      if (f.name && f.name !== 'image.png') return f;
      var ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      var name = 'pasted-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + (i ? '-' + i : '') + '.' + ext;
      try { return new File([f], name, { type: f.type }); } catch (err) { return f; }
    }));
  });

  bootstrap();
})();
