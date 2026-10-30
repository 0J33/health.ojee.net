/* TEST ONLY. Never shipped: deploy.sh leaves tests/ out, and nothing in web/
   loads this file.

   A stand-in for what the Health iPhone app puts on the page, so the
   native Bluetooth transport in web/js/live.js can be driven in an ordinary
   browser. Load it before the page's own scripts:

     agent-browser --init-script tests/fake-capacitor-ble.js open http://localhost:5049/

   It mimics the RAW plugin object (window.Capacitor.Plugins.BluetoothLe) of
   @capacitor-community/bluetooth-le 8.3.0 on iOS, as read from its source
   (ios/Sources/BluetoothLe/Plugin.swift, DeviceManager.swift, Device.swift,
   Conversion.swift) and from Capacitor's own bridge (JSExport.swift,
   native-bridge.js):

   - every method takes one options object and returns a promise; a failure
     rejects with an Error whose message is the plugin's own text
   - addListener(event, fn) returns { remove() } at once, not a promise
   - nothing works before initialize(): "Bluetooth LE not initialized."
   - connect() needs the peripheral to have been handed over in this run of
     the app, by requestDevice or getDevices: "Device not found. Call
     'requestDevice', 'requestLEScan' or 'getDevices' first."
   - connect() waits for the sensor for `timeout` ms (default 10 s), then
     rejects "Connection timeout."; a second connect() for the same device
     replaces the first, whose promise then never settles
   - disconnect() resolves at once when not connected, and does not cancel a
     connect() that is still waiting
   - a lost connection fires "disconnected|<DEVICE ID>" with no data
   - a notification fires "notification|<DEVICE ID>|<service>|<characteristic>"
     (the UUIDs as passed in, lower case) with { value: "<hex, no spaces>" }
   - device ids are upper-case UUIDs; onEnabledChanged carries { value }

   The page reload is the app being started again: the fake forgets
   everything except the one thing a real phone keeps, the peripheral it has
   met (getDevices finds it by id).

   Drive it from the test through window.__ble:
     calls                      every raw call so far: [method, options]
     range(false|true)          the sensor walks away / comes back
     power(false|true)          Bluetooth switched off / on
     bpm = 132                  what the sensor reports
     skin(false|true)           worn or not (sensor-contact bit)
     silent(true|false)         stay connected but send nothing (a stall)
     cancelNext = true          the person closes the chooser
     systemHeld = true          another app (Google Health) keeps the sensor
                                connected to the phone: no scan finds it,
                                getConnectedDevices hands it over (set before
                                load via localStorage 'fakeble.held' = '1')
     deny = true                Bluetooth permission refused (set before load via
                                localStorage 'fakeble.deny' = '1')
     opened                     addresses handed to the system browser
*/
(function () {
  if (window.top !== window) return;
  var ID = '5F1C2D3E-9A8B-4C7D-8E6F-0A1B2C3D4E5F';
  var NAME = 'Polar H10 7A3B';
  var ls = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };

  var st = {
    initialized: false, enabled: ls('fakeble.off') !== '1', deny: ls('fakeble.deny') === '1',
    inRange: ls('fakeble.away') !== '1',
    deviceMap: {},            // ids handed over in this run
    connected: false, notifying: null, pending: null, silent: false,
    bpm: 72, contact: true, wide: false,
    listeners: {},            // event → [fn]
  };
  var calls = [];
  var fail = function (message) { var e = new Error(message); e.errorMessage = message; return Promise.reject(e); };
  var later = function (ms, v) { return new Promise(function (r) { setTimeout(function () { r(v); }, ms); }); };
  var emit = function (event, data) { (st.listeners[event] || []).slice().forEach(function (fn) { try { fn(data); } catch (e) { console.error(e); } }); };
  var need = function () { return st.initialized ? null : fail('Bluetooth LE not initialized.'); };
  var device = function (o, checkConnection) {
    if (!o || typeof o.deviceId !== 'string') return fail('deviceId required.');
    if (!st.deviceMap[o.deviceId]) return fail("Device not found. Call 'requestDevice', 'requestLEScan' or 'getDevices' first.");
    if (checkConnection && !st.connected) return fail('Not connected to device.');
    return null;
  };
  var hex = function (bytes) { return bytes.map(function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(''); };

  /* Heart Rate Measurement, as a strap sends it: flags, bpm, then RR intervals. */
  function measurement() {
    var flags = 0x04 | (st.contact ? 0x02 : 0) | 0x10 | (st.wide ? 0x01 : 0);
    var rr = Math.round(60000 / Math.max(30, st.bpm) * 1.024);
    var body = st.wide ? [st.bpm & 0xff, st.bpm >> 8] : [st.bpm & 0xff];
    return hex([flags].concat(body, [rr & 0xff, rr >> 8]));
  }
  setInterval(function () {
    if (!st.connected || !st.notifying || st.silent) return;
    st.bpm = Math.max(40, Math.min(190, st.bpm + Math.round((Math.random() - 0.5) * 4)));
    emit(st.notifying, { value: measurement() });
  }, 1000);

  function drop() {
    if (!st.connected) return;
    st.connected = false; st.notifying = null;
    emit('disconnected|' + ID, undefined);
  }
  function arrive() {
    var p = st.pending;
    if (!p || !st.inRange || !st.enabled) return;
    st.pending = null; clearTimeout(p.timer);
    // didConnect, then the services are discovered, then the call resolves.
    setTimeout(function () { st.connected = true; p.resolve(); }, 350);
  }

  var P = {
    addListener: function (event, fn) {
      calls.push(['addListener', event]);
      (st.listeners[event] = st.listeners[event] || []).push(fn);
      return { remove: function () { var a = st.listeners[event] || []; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); return Promise.resolve(); } };
    },
    removeAllListeners: function () { calls.push(['removeAllListeners']); st.listeners = {}; return Promise.resolve(); },
    initialize: function (o) {
      calls.push(['initialize', o]);
      if (st.deny) return later(60).then(function () { return fail('BLE permission denied'); });
      return later(60).then(function () { st.initialized = true; });
    },
    isEnabled: function () { calls.push(['isEnabled']); return need() || Promise.resolve({ value: st.enabled }); },
    startEnabledNotifications: function () { calls.push(['startEnabledNotifications']); return need() || Promise.resolve(); },
    requestDevice: function (o) {
      calls.push(['requestDevice', o]);
      var n = need(); if (n) return n;
      if (api.cancelNext) { api.cancelNext = false; return later(200).then(function () { return fail('requestDevice cancelled.'); }); }
      // The chooser: the person picks the one sensor in range.
      return later(500).then(function () {
        if (!st.inRange || !st.enabled || api.systemHeld) return fail('requestDevice cancelled.');   // held by another app: it does not advertise
        st.deviceMap[ID] = true;
        return { deviceId: ID, name: NAME };
      });
    },
    getDevices: function (o) {
      calls.push(['getDevices', o]);
      var n = need(); if (n) return n;
      if (!o || !Array.isArray(o.deviceIds)) return fail('deviceIds must be provided');
      var found = o.deviceIds.filter(function (id) { return String(id).toUpperCase() === ID; });
      found.forEach(function () { st.deviceMap[ID] = true; });
      return Promise.resolve({ devices: found.map(function () { return { deviceId: ID, name: NAME }; }) });
    },
    getConnectedDevices: function (o) {
      calls.push(['getConnectedDevices', o]);
      var n = need(); if (n) return n;
      // Connected to the phone by another app (systemHeld): handed over, and known from then on.
      if (!api.systemHeld || !st.inRange || !st.enabled) return Promise.resolve({ devices: [] });
      st.deviceMap[ID] = true;
      return Promise.resolve({ devices: [{ deviceId: ID, name: NAME }] });
    },
    connect: function (o) {
      calls.push(['connect', o]);
      var bad = need() || device(o, false); if (bad) return bad;
      if (st.pending) { clearTimeout(st.pending.timer); st.pending = null; }   // the earlier call is left hanging, as in the plugin
      return new Promise(function (resolve, reject) {
        var ms = typeof o.timeout === 'number' ? o.timeout : 10000;
        var p = { resolve: resolve };
        p.timer = setTimeout(function () { if (st.pending === p) { st.pending = null; var e = new Error('Connection timeout.'); e.errorMessage = e.message; reject(e); } }, Math.min(ms, 2147483647));
        st.pending = p;
        arrive();
      });
    },
    disconnect: function (o) {
      calls.push(['disconnect', o]);
      var bad = need() || device(o, false); if (bad) return bad;
      if (!st.connected) return Promise.resolve();
      return later(40).then(function () { drop(); });
    },
    startNotifications: function (o) {
      calls.push(['startNotifications', o]);
      var bad = need() || device(o, true); if (bad) return bad;
      if (!o.service) return fail('Service UUID required.');
      if (!o.characteristic) return fail('Characteristic UUID required.');
      if (String(o.service).toLowerCase() !== '0000180d-0000-1000-8000-00805f9b34fb' || String(o.characteristic).toLowerCase() !== '00002a37-0000-1000-8000-00805f9b34fb') return fail('Characteristic not found.');
      return later(120).then(function () {
        if (!st.connected) return fail('Not connected to device.');
        st.notifying = 'notification|' + ID + '|' + String(o.service).toLowerCase() + '|' + String(o.characteristic).toLowerCase();
      });
    },
    stopNotifications: function (o) { calls.push(['stopNotifications', o]); st.notifying = null; return Promise.resolve(); },
  };

  var bar = { setStyle: function (o) { calls.push(['StatusBar.setStyle', o]); return Promise.resolve(); } };

  var api = {
    calls: calls, state: st, id: ID, name: NAME, cancelNext: false, opened: [], systemHeld: ls('fakeble.held') === '1',
    range: function (on) { st.inRange = Boolean(on); if (on) arrive(); else drop(); },
    power: function (on) {
      st.enabled = Boolean(on);
      if (!on) { st.pending = null; drop(); }   // the phone lets go of a waiting connect without a word
      emit('onEnabledChanged', { value: st.enabled });
    },
    skin: function (on) { st.contact = Boolean(on); },
    silent: function (on) { st.silent = Boolean(on); },
    names: function () { return calls.map(function (c) { return c[0]; }); },
  };
  Object.defineProperty(api, 'bpm', { get: function () { return st.bpm; }, set: function (v) { st.bpm = v; } });
  window.__ble = api;

  window.Capacitor = {
    isNativePlatform: function () { return true; },
    getPlatform: function () { return 'ios'; },
    isPluginAvailable: function (name) { return Object.prototype.hasOwnProperty.call(window.Capacitor.Plugins, name); },
    Plugins: { BluetoothLe: P, StatusBar: bar },
  };

  // The app hands a new window to Safari and gives the page nothing back.
  window.open = function (url) { api.opened.push(String(url)); return null; };
}());
