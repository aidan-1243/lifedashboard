// Color palette + day / night theme that follows your local sunrise and sunset.
// Loaded as a plain script in <head> so the right colors show before the first paint.
// The location comes from your weather setting (rounded to ~1 km) and is cached on
// this device only; until one is known it uses 7 AM to 7 PM.
(function () {
  const KEY = 'life_sun_loc';
  const PKEY = 'life_palette';
  // Palettes (colors live in style.css). sky = status-bar color for day / night.
  const PALETTES = [{"key": "coastal", "name": "Coastal", "sky": ["#E4EEF6", "#15284A"], "swatches": ["#F6F3EC", "#DCEBF5", "#14243B", "#E8573D", "#0C1626"]}, {"key": "paper", "name": "Paper and ink", "sky": ["#EAF0FA", "#141C2C"], "swatches": ["#F7F8FA", "#E8F0FF", "#141B2D", "#2563EB", "#0D1117"]}, {"key": "clay", "name": "Desert clay", "sky": ["#F2E2D2", "#2A2119"], "swatches": ["#F5EFE6", "#F1D9C6", "#5C6B3A", "#C0582F", "#1C1814"]}, {"key": "citrus", "name": "Citrus pop", "sky": ["#FFF4CC", "#221D0C"], "swatches": ["#FFFFFF", "#FFE36E", "#0F8C82", "#EA5514", "#121212"]}, {"key": "forest", "name": "Forest and brass", "sky": ["#E3EADC", "#17291E"], "swatches": ["#F3F1EA", "#E4EADF", "#24402E", "#8E6C2B", "#101A14"]}, {"key": "graphite", "name": "Graphite and violet", "sky": ["#EAE5F7", "#1E1932"], "swatches": ["#F4F3F1", "#EFE9FF", "#2A2927", "#7C4DFF", "#141413"]}];
  const palette = () => { let k = ''; try { k = localStorage.getItem(PKEY) || ''; } catch (_) {} return PALETTES.find((p) => p.key === k) || PALETTES[0]; };
  let timer = null;

  // Sunrise/sunset for the day containing `date` (NOAA-style approximation, within a minute or two).
  function sunTimes(date, lat, lon) {
    const rad = Math.PI / 180, dayMs = 864e5, J1970 = 2440588, J2000 = 2451545;
    const noon = new Date(date); noon.setHours(12, 0, 0, 0);
    const d = noon.valueOf() / dayMs - 0.5 + J1970 - J2000;
    const lw = rad * -lon, phi = rad * lat, e = rad * 23.4397;
    const n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
    const ds = 0.0009 + lw / (2 * Math.PI) + n;
    const M = rad * (357.5291 + 0.98560028 * ds);
    const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = M + C + rad * 102.9372 + Math.PI;
    const dec = Math.asin(Math.sin(L) * Math.sin(e));
    const fix = 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    const jNoon = J2000 + ds + fix;
    const cosW = (Math.sin(-0.833 * rad) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
    if (cosW > 1) return { polar: 'night' };
    if (cosW < -1) return { polar: 'day' };
    const jSet = J2000 + 0.0009 + (Math.acos(cosW) + lw) / (2 * Math.PI) + n + fix;
    const toDate = (j) => new Date((j + 0.5 - J1970) * dayMs);
    return { rise: toDate(jNoon - (jSet - jNoon)), set: toDate(jSet) };
  }

  function loc() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v && isFinite(v.lat) && isFinite(v.lon)) return v; } catch (_) {}
    return null;
  }

  function times(date) {
    const l = loc();
    if (l) { const t = sunTimes(date, l.lat, l.lon); if (!t.polar) return t; }
    const rise = new Date(date); rise.setHours(7, 0, 0, 0);
    const set = new Date(date); set.setHours(19, 0, 0, 0);
    return { rise, set };
  }

  function apply() {
    const now = new Date();
    const t = times(now);
    const isDay = now >= t.rise && now < t.set;
    const theme = isDay ? 'day' : 'night';
    const root = document.documentElement;
    if (root.dataset.theme !== theme) root.dataset.theme = theme;
    const pal = palette();
    if (root.dataset.palette !== pal.key) root.dataset.palette = pal.key;
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
    meta.content = pal.sky[isDay ? 0 : 1];
    // Schedule the next change (re-checked when the app comes back to the foreground too).
    let next = now < t.rise ? t.rise : now < t.set ? t.set : times(new Date(now.valueOf() + 864e5)).rise;
    clearTimeout(timer);
    timer = setTimeout(apply, Math.min(Math.max(next - now + 1000, 30000), 6 * 3600000));
    window.lifeTheme.today = t;
    window.lifeTheme.current = theme;
  }

  window.lifeTheme = {
    // Called by the app once it knows the weather location.
    setLocation(lat, lon) {
      lat = +lat; lon = +lon;
      const cur = loc();
      if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return;
      if (cur && cur.lat === lat && cur.lon === lon) return;
      try { localStorage.setItem(KEY, JSON.stringify({ lat, lon })); } catch (_) {}
      apply();
    },
    hasLocation: () => !!loc(),
    palettes: PALETTES,
    palette: () => palette().key,
    // Remembered on this device so the right colors show before the app loads.
    setPalette(key) {
      if (!PALETTES.some((p) => p.key === key)) return;
      try { if (localStorage.getItem(PKEY) === key) return; localStorage.setItem(PKEY, key); } catch (_) {}
      apply();
    },
    apply,
  };
  apply();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) apply(); });
})();
