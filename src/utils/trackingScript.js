// The tracking script served to a tenant's website, built per organization.
//
// Generated rather than shipped as a static file because its behaviour depends on settings the
// tenant owns: how long to remember a visitor, whether to wait for cookie consent, which
// parameters to forward. Serving one static script and configuring it from data attributes
// would work too, but then every setting change would need a cache purge on someone else's
// CDN before it took effect.
//
// Deliberately small, dependency-free and ES5: it loads on travel websites built on
// WordPress themes from 2016, and a script that needs a polyfill is a script that silently
// records nothing on a third of the traffic.

/** Keys the script forwards from the query string. Everything else is ignored client-side. */
function trackedKeys(config) {
  const keys = [];
  for (const p of [...(config.params || []), ...(config.custom || [])]) {
    if (!p.enabled || p.derived) continue;
    keys.push(p.key, ...(p.aliases || []));
  }
  return [...new Set(keys)];
}

export function buildTrackingScript({ token, baseUrl, config, settings }) {
  const endpoint = baseUrl.replace(/\/+$/, '') + '/api/public/track/' + token;
  const leadEndpoint = baseUrl.replace(/\/+$/, '') + '/api/public/leads/' + token;
  const cap = settings?.capture || {};
  const payload = {
    keys: trackedKeys(config),
    retentionDays: cap.retentionDays || 90,
    requireConsent: cap.requireConsent === true,
    trackSubdomains: cap.trackSubdomains !== false,
    hosts: cap.siteHosts || [],
  };

  // Hidden-field names, so a manually instrumented form can be filled by the same script.
  const fieldNames = [...(config.params || []), ...(config.custom || [])]
    .filter((p) => p.enabled)
    .map((p) => p.field);

  return `/* Lead source tracking. Generated for this website - do not edit by hand. */
(function (w, d) {
  'use strict';
  if (w.nnc && w.nnc.ready) return;

  var CFG = ${JSON.stringify(payload)};
  var ENDPOINT = ${JSON.stringify(endpoint)};
  var LEAD_ENDPOINT = ${JSON.stringify(leadEndpoint)};
  var FIELDS = ${JSON.stringify(fieldNames)};
  var VKEY = 'nnc_vid';
  var SKEY = 'nnc_seen';
  var PKEY = 'nnc_params';

  function store(k, v, days) {
    try { w.localStorage.setItem(k, v); } catch (e) { /* private mode */ }
    try {
      var exp = new Date(Date.now() + (days || CFG.retentionDays) * 864e5).toUTCString();
      // Set on the registrable domain when subdomains are tracked, so book.site.com and
      // site.com are the same visitor rather than two.
      var host = d.location.hostname;
      var dom = '';
      if (CFG.trackSubdomains) {
        var parts = host.split('.');
        if (parts.length > 2) dom = '; domain=.' + parts.slice(-2).join('.');
      }
      d.cookie = k + '=' + encodeURIComponent(v) + '; expires=' + exp + '; path=/; SameSite=Lax' + dom;
    } catch (e) { /* ignore */ }
  }

  function read(k) {
    try { var v = w.localStorage.getItem(k); if (v) return v; } catch (e) { /* ignore */ }
    try {
      var m = d.cookie.match('(^|;)\\\\s*' + k + '\\\\s*=\\\\s*([^;]+)');
      return m ? decodeURIComponent(m[2]) : null;
    } catch (e) { return null; }
  }

  function uuid() {
    try { if (w.crypto && w.crypto.randomUUID) return w.crypto.randomUUID(); } catch (e) { /* ignore */ }
    var s = '';
    for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  function visitorId() {
    var id = read(VKEY);
    if (!id) { id = uuid(); store(VKEY, id); }
    return id;
  }

  function queryParams() {
    var out = {};
    var qs = d.location.search.replace(/^\\?/, '');
    if (!qs) return out;
    qs.split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      var k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
      var v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\\+/g, ' '));
      if (CFG.keys.indexOf(k) >= 0 && v) out[k] = v;
    });
    return out;
  }

  function device() {
    var ua = w.navigator.userAgent || '';
    var mobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|Mobile/i.test(ua);
    var os = /Android/i.test(ua) ? 'Android'
      : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
      : /Windows/i.test(ua) ? 'Windows'
      : /Mac OS/i.test(ua) ? 'macOS'
      : /Linux/i.test(ua) ? 'Linux' : 'Unknown';
    return (mobile ? 'Mobile' : 'Desktop') + ', ' + os;
  }

  function gaClientId() {
    var m = read('_ga');
    if (!m) return '';
    var p = String(m).split('.');
    return p.length >= 4 ? 'GA1.1.' + p[2] + '.' + p[3] : '';
  }

  // The parameters of the visit that brought them here, kept so a form submitted three pages
  // later still knows where the person came from.
  function rememberVisit() {
    var p = queryParams();
    var ref = d.referrer || '';
    var internal = false;
    try {
      if (ref) {
        var h = ref.split('/')[2] || '';
        internal = h === d.location.hostname
          || (CFG.hosts || []).some(function (x) { return h === x || h === 'www.' + x; });
      }
    } catch (e) { /* ignore */ }

    var hasTags = Object.keys(p).length > 0;
    var landed = { url: d.location.href, referrer: internal ? '' : ref, at: Date.now() };
    var prev = null;
    try { prev = JSON.parse(read(PKEY) || 'null'); } catch (e) { /* ignore */ }

    // A page-to-page hop with no new tags must not overwrite the ad that started the visit.
    if (!hasTags && !ref && prev) return prev;
    if (!hasTags && internal && prev) return prev;
    store(PKEY, JSON.stringify(landed));
    return landed;
  }

  function consented() {
    if (!CFG.requireConsent) return true;
    return read('nnc_consent') === 'yes';
  }

  function send(path, body, cb) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', path, true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.onload = function () {
        var out = null;
        try { out = JSON.parse(x.responseText); } catch (e) { /* ignore */ }
        if (cb) cb(x.status >= 200 && x.status < 300 ? null : new Error('HTTP ' + x.status), out);
      };
      x.onerror = function () { if (cb) cb(new Error('network')); };
      x.send(JSON.stringify(body));
    } catch (e) { if (cb) cb(e); }
  }

  var visit = null;

  function track() {
    if (!consented()) return;
    visit = rememberVisit();
    var once = read(SKEY + ':' + visit.at);
    if (once) return; // already reported this landing
    store(SKEY + ':' + visit.at, '1', 1);
    send(ENDPOINT, {
      visitorId: visitorId(),
      url: visit.url,
      referrer: visit.referrer,
      device: device(),
      gaClientId: gaClientId(),
    });
  }

  // Everything a form needs to carry so the lead arrives attributed. Exposed for sites that
  // post their own forms (React apps, custom handlers).
  function getFields() {
    if (!visit) visit = rememberVisit();
    return {
      nnc_visitor_id: visitorId(),
      nnc_url: visit.url,
      nnc_referrer: visit.referrer,
      nnc_device: device(),
      nnc_ga_client_id: gaClientId(),
      nnc_form_page: d.location.pathname,
    };
  }

  // Automatic mode: stamp hidden inputs into every form on the page so an ordinary HTML form
  // post carries the attribution without the site owner touching their markup.
  function decorate() {
    var forms = d.getElementsByTagName('form');
    for (var i = 0; i < forms.length; i++) {
      var f = forms[i];
      if (f.getAttribute('data-nnc') === 'done' || f.getAttribute('data-nnc') === 'skip') continue;
      var vals = getFields();
      for (var k in vals) {
        if (!Object.prototype.hasOwnProperty.call(vals, k)) continue;
        if (f.querySelector('input[name="' + k + '"]')) continue;
        var inp = d.createElement('input');
        inp.type = 'hidden';
        inp.name = k;
        inp.value = vals[k] == null ? '' : String(vals[k]);
        f.appendChild(inp);
      }
      f.setAttribute('data-nnc', 'done');
    }
  }

  // Posts a lead straight to the CRM, for sites that would rather not run their own endpoint.
  function submitLead(data, cb) {
    var body = {};
    for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) body[k] = data[k];
    var f = getFields();
    body.visitorId = f.nnc_visitor_id;
    body.url = f.nnc_url;
    body.referrer = f.nnc_referrer;
    body.device = f.nnc_device;
    body.gaClientId = f.nnc_ga_client_id;
    body.conversionPage = f.nnc_form_page;
    send(LEAD_ENDPOINT, body, cb);
  }

  w.nnc = {
    ready: true,
    fields: FIELDS,
    getFields: getFields,
    submitLead: submitLead,
    track: track,
    consent: function () { store('nnc_consent', 'yes'); track(); },
    decorate: decorate,
  };

  track();
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', decorate);
  else decorate();
  // Forms injected later by a popup or a single-page router still get stamped.
  setInterval(decorate, 2000);
})(window, document);
`;
}

/** The hidden inputs a site owner pastes when they would rather not let the script touch their
 *  forms. Shown on the UTM Capture page next to the install snippets. */
export function hiddenFieldsSnippet() {
  return [
    'nnc_visitor_id',
    'nnc_url',
    'nnc_referrer',
    'nnc_device',
    'nnc_ga_client_id',
    'nnc_form_page',
  ]
    .map((n) => '<input type="hidden" name="' + n + '">')
    .join('\n');
}

/** Install instructions per stack, with this tenant's values already substituted. */
export function installSnippets({ scriptUrl, leadEndpoint, token }) {
  const tag = '<script src="' + scriptUrl + '" async></script>';
  return [
    {
      key: 'html',
      label: 'Any website (HTML)',
      language: 'html',
      code: '<!-- Paste immediately before </head> on every page -->\n' + tag,
    },
    {
      key: 'wordpress',
      label: 'WordPress',
      language: 'text',
      code: [
        'Appearance > Theme File Editor > header.php',
        'Paste this just before </head>:',
        '',
        tag,
        '',
        'Or, without touching the theme: install any "insert headers and footers"',
        'plugin and paste the same line into its header box.',
        'Works with Elementor, Contact Form 7, WPForms and Gravity Forms - the script',
        'stamps their forms automatically, so no per-form setup is needed.',
      ].join('\n'),
    },
    {
      key: 'gtm',
      label: 'Google Tag Manager',
      language: 'text',
      code: [
        'Tags > New > Tag Configuration > Custom HTML',
        '',
        tag,
        '',
        'Triggering: All Pages (Initialization). Then Submit > Publish.',
        'Use this when the client already has GTM - it needs no developer.',
      ].join('\n'),
    },
    {
      key: 'nextjs',
      label: 'Next.js',
      language: 'jsx',
      code: [
        '// app/layout.tsx',
        "import Script from 'next/script';",
        '',
        '<Script src="' + scriptUrl + '" strategy="afterInteractive" />',
        '',
        '// Then in the form submit handler, merge the attribution in:',
        'const payload = { ...formData, ...window.nnc.getFields() };',
      ].join('\n'),
    },
    {
      key: 'react',
      label: 'React / SPA',
      language: 'js',
      code: [
        '// index.html head:',
        tag,
        '',
        '// Submit handler - post straight to the CRM:',
        'window.nnc.submitLead(',
        '  { name, phone, email, formName: "Get Quote", message },',
        '  (err) => (err ? showError() : showThanks())',
        ');',
        '',
        '// Or post to your own backend and forward these fields:',
        '// ' + leadEndpoint,
      ].join('\n'),
    },
    {
      key: 'manual',
      label: 'Manual hidden fields',
      language: 'html',
      code: [
        '<!-- Paste inside each <form>. The script fills the values in. -->',
        hiddenFieldsSnippet(),
        '',
        '<!-- Add data-nnc="skip" to a form the script should leave alone -->',
      ].join('\n'),
    },
  ];
}
