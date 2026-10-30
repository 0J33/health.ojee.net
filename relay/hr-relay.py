#!/usr/bin/env python3
"""health.ojee.net heart-rate relay: live heart rate for browsers that cannot
use Bluetooth (Safari on iPhone and Mac, Firefox), from a computer at home.

A Fitbit Air with "Share heart rate" on in the Google Health app (or any
chest strap) broadcasts the standard Bluetooth Heart Rate Service. This runs
on an always-on Linux box with Bluetooth (BlueZ), connects to the person's
own sensor when it is in range, and posts each reading to
POST /api/live/hr with a link key; the site passes it to every tab the
person has open, which then shows it live.

It never keeps the sensor from the person's own devices. A browser or the
iPhone app about to connect claims it on the site; the next post here is
answered with "yield", and this lets go at once. It takes the sensor again
only when GET /api/live/relay says nothing else has been delivering for a
while. It only connects to sensors the person has used in the app (the site
tells it their names), or, until there are any, to a Fitbit.

Bluetooth is BlueZ over D-Bus on a GLib main loop; posting runs on a thread.
Searching scans in bursts, and stops while connected or stepping aside.

    hr-relay.py                 run (as a systemd user service)
    config ~/.config/health-hr-relay/config.json  {"url", "source", "match"}
    key    ~/.config/health-hr-relay/key           the link key (0600)
"""

from __future__ import annotations

import json
import os
import queue
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import dbus
import dbus.mainloop.glib
from gi.repository import GLib

dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)

BLUEZ = "org.bluez"
HRS = "0000180d-0000-1000-8000-00805f9b34fb"
HRM = "00002a37-0000-1000-8000-00805f9b34fb"
PROPS = "org.freedesktop.DBus.Properties"
DEV = "org.bluez.Device1"
CHR = "org.bluez.GattCharacteristic1"

SCAN_ON = 4000          # ms of scanning
SCAN_OFF = 6000         # ms of rest between bursts
STALL = 20              # s without a value while connected: drop and search again
FIRST_VALUE = 30        # s allowed for the first value (the Air takes ~9)
ASK_EVERY = 10          # s between "may I?" questions while stepping aside
CLEAR_FOR = 20          # s the coast must be clear before taking the sensor again
NAMES_EVERY = 300       # s between refreshes of the person's sensor names

CONF_DIR = os.path.expanduser("~/.config/health-hr-relay")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def load_conf():
    conf = {"url": "https://health.ojee.net", "source": f"relay-{socket.gethostname()[:16].lower()}", "match": ""}
    try:
        with open(os.path.join(CONF_DIR, "config.json")) as f:
            conf.update(json.load(f))
    except FileNotFoundError:
        pass
    with open(os.path.join(CONF_DIR, "key")) as f:
        conf["key"] = f.read().strip()
    if not conf["source"].startswith("relay"):
        conf["source"] = "relay-" + conf["source"]
    return conf


def parse_hrm(b: bytes):
    """Heart Rate Measurement: flags, then a uint8 or uint16 bpm; 0 when off the skin."""
    if len(b) < 2:
        return None
    if b[0] & 0x01:
        if len(b) < 3:
            return None
        bpm = int.from_bytes(b[1:3], "little")
    else:
        bpm = b[1]
    if b[0] & 0x04 and not b[0] & 0x02:
        return 0
    return bpm


class Site:
    """Talks to the site on a thread, so Bluetooth never waits for the network."""

    def __init__(self, conf, on_yield, on_answer):
        self.conf = conf
        self.on_yield = on_yield
        self.on_answer = on_answer
        self.q: queue.Queue = queue.Queue()
        self.pending: list[dict] = []
        threading.Thread(target=self._run, daemon=True).start()

    def _req(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.conf["url"] + path, data=data, method=method, headers={
            "authorization": f"Bearer {self.conf['key']}", "content-type": "application/json",
            "accept": "application/json", "user-agent": "health-hr-relay/1"})
        with urllib.request.urlopen(r, timeout=10) as res:
            return json.loads(res.read() or b"{}")

    def reading(self, bpm):
        self.q.put(("hr", {"t": int(time.time() * 1000), "bpm": bpm}))

    def ask(self):
        self.q.put(("ask", None))

    def _run(self):
        last_post = 0.0
        while True:
            try:
                kind, item = self.q.get(timeout=1)
            except queue.Empty:
                kind, item = None, None
            if kind == "hr":
                self.pending.append(item)
            elif kind == "ask":
                try:
                    a = self._req("GET", f"/api/live/relay?source={urllib.parse.quote(self.conf['source'])}")
                    GLib.idle_add(self.on_answer, a)
                except Exception as e:  # noqa: BLE001
                    log("ask failed:", e)
                    GLib.idle_add(self.on_answer, None)
            now = time.time()
            self.pending = [p for p in self.pending if now * 1000 - p["t"] < 55_000][-20:]
            if self.pending and now - last_post >= 0.9:
                batch, last_post = self.pending[:20], now
                try:
                    a = self._req("POST", "/api/live/hr", {"samples": batch, "source": self.conf["source"]})
                    self.pending = [p for p in self.pending if p not in batch]
                    if a.get("yield"):
                        self.pending = []
                        GLib.idle_add(self.on_yield, a.get("why") or "")
                except urllib.error.HTTPError as e:
                    if e.code in (400, 413):
                        self.pending = [p for p in self.pending if p not in batch]
                    elif e.code == 401:
                        log("the link key was refused: make a new one on the site")
                        self.pending = []
                        time.sleep(30)
                except Exception as e:  # noqa: BLE001
                    log("post failed:", e)


class Relay:
    def __init__(self, conf):
        self.conf = conf
        self.bus = dbus.SystemBus()
        self.adapter = None
        self.mode = "asking"          # asking | searching | connecting | live | aside
        self.dev_path = self.chr_path = None
        self.dev_name = ""
        self.seen: dict[str, tuple[float, str, int]] = {}
        self.scanning = False
        self.last_value = 0.0
        self.subscribed_at = 0.0
        self.names: list[str] = []
        self.names_at = 0.0
        self.clear_since = None
        self.cycle = None
        self.site = Site(conf, self._yield, self._answer)
        self.bus.add_signal_receiver(self._props_changed, "PropertiesChanged", PROPS, bus_name=BLUEZ, path_keyword="path")
        self.bus.add_signal_receiver(self._added, "InterfacesAdded", "org.freedesktop.DBus.ObjectManager", bus_name=BLUEZ)
        GLib.timeout_add_seconds(2, self._watchdog)

    # ── the site: may I? ──────────────────────────────────────────────

    def start(self):
        self._later(0, self._ask)

    def _ask(self):
        self.site.ask()
        return False

    def _answer(self, a):
        if a is None:
            self._later(ASK_EVERY * 1000, self._ask)
            return False
        if time.time() - self.names_at > NAMES_EVERY or a.get("names"):
            self.names, self.names_at = [str(n) for n in (a.get("names") or [])], time.time()
        if self.mode in ("asking", "aside"):
            if a.get("busy"):
                self.clear_since = None
                if self.mode != "aside":
                    log("stepping aside:", a.get("why"))
                self.mode = "aside"
                self._later(ASK_EVERY * 1000, self._ask)
            else:
                if self.mode == "aside":
                    self.clear_since = self.clear_since or time.time()
                    if time.time() - self.clear_since < CLEAR_FOR:
                        self._later(ASK_EVERY * 1000, self._ask)
                        return False
                self.clear_since = None
                self.mode = "searching"
                log("searching")
                self._tick()
        return False

    def _yield(self, why):
        if self.mode in ("aside", "asking"):
            return False
        log("handing the sensor over:", why)
        self._stop_scan()
        self._drop()
        self.mode = "aside"
        self.clear_since = None
        self._later(ASK_EVERY * 1000, self._ask)
        return False

    # ── Bluetooth ─────────────────────────────────────────────────────

    def _later(self, ms, fn):
        if self.cycle:
            GLib.source_remove(self.cycle)
        def run():
            self.cycle = None
            return fn()
        self.cycle = GLib.timeout_add(ms, run)

    def _objects(self):
        om = dbus.Interface(self.bus.get_object(BLUEZ, "/"), "org.freedesktop.DBus.ObjectManager")
        return om.GetManagedObjects()

    def _find_adapter(self):
        try:
            for path, ifs in self._objects().items():
                a = ifs.get("org.bluez.Adapter1")
                if a is not None:
                    return str(path) if bool(a.get("Powered")) else None
        except dbus.DBusException:
            return None
        return None

    def _tick(self):
        if self.mode != "searching" or self.dev_path:
            return False
        self.adapter = self._find_adapter()
        if not self.adapter:
            self.scanning = False
            self._later(10_000, self._tick)
            return False
        if self.scanning:
            self._stop_scan()
            pick = self._pick()
            if pick:
                self._connect(pick)
                return False
            # Every few bursts, ask again (a browser may have started meanwhile).
            self._later(SCAN_OFF, self._ask_then_search)
        else:
            self._start_scan()
            self._later(SCAN_ON, self._tick)
        return False

    def _ask_then_search(self):
        self.mode = "asking"
        self.site.ask()
        return False

    def _start_scan(self):
        self.seen.clear()
        try:
            ad = dbus.Interface(self.bus.get_object(BLUEZ, self.adapter), "org.bluez.Adapter1")
            ad.SetDiscoveryFilter({"UUIDs": dbus.Array([HRS], signature="s"), "Transport": "le", "DuplicateData": dbus.Boolean(True)})
            ad.StartDiscovery()
            self.scanning = True
        except dbus.DBusException as e:
            self.scanning = "InProgress" in str(e)

    def _stop_scan(self):
        if not self.scanning or not self.adapter:
            self.scanning = False
            return
        self.scanning = False
        try:
            dbus.Interface(self.bus.get_object(BLUEZ, self.adapter), "org.bluez.Adapter1").StopDiscovery()
        except dbus.DBusException:
            pass

    def _mine(self, name: str) -> bool:
        """Only the person's own sensor: one they used in the app, or a Fitbit until then."""
        n = (name or "").strip().lower()
        if not n:
            return False
        if self.conf.get("match"):
            return re.search(self.conf["match"], n, re.I) is not None
        if self.names:
            return any(n == x.lower() or x.lower() in n for x in self.names)
        return "fitbit" in n or n.startswith("air")

    def _note(self, path, props):
        if not self.scanning or not str(path).startswith(self.adapter or "/none"):
            return
        try:
            allp = dbus.Interface(self.bus.get_object(BLUEZ, path), PROPS).GetAll(DEV)
        except dbus.DBusException:
            return
        if HRS not in [str(u).lower() for u in allp.get("UUIDs", [])]:
            return
        name = str(allp.get("Name", allp.get("Alias", "")))
        if not self._mine(name):
            return
        self.seen[str(path)] = (time.time(), name, int(props.get("RSSI", allp.get("RSSI", -127))))

    def _pick(self):
        if not self.seen:
            return None
        return max(self.seen.items(), key=lambda item: item[1][2])

    def _connect(self, pick):
        path, (_, name, _) = pick
        self.dev_path, self.dev_name = path, name
        self.mode = "connecting"
        log("connecting to", name)
        dbus.Interface(self.bus.get_object(BLUEZ, path), DEV).Connect(reply_handler=self._connected, error_handler=self._failed, timeout=20)

    def _connected(self):
        self.subscribed_at = time.time()
        self._resolve(0)

    def _resolve(self, tries):
        if not self.dev_path:
            return False
        try:
            resolved = bool(dbus.Interface(self.bus.get_object(BLUEZ, self.dev_path), PROPS).Get(DEV, "ServicesResolved"))
        except dbus.DBusException:
            resolved = False
        if not resolved:
            if tries > 40:
                self._failed("services never resolved")
                return False
            GLib.timeout_add(250, lambda: self._resolve(tries + 1))
            return False
        for p, ifs in self._objects().items():
            c = ifs.get(CHR)
            if c and str(p).startswith(self.dev_path) and str(c.get("UUID", "")).lower() == HRM:
                self.chr_path = str(p)
                break
        if not self.chr_path:
            self._failed("no heart-rate measurement")
            return False
        self.subscribed_at = time.time()
        self.last_value = 0.0
        dbus.Interface(self.bus.get_object(BLUEZ, self.chr_path), CHR).StartNotify(reply_handler=lambda: None, error_handler=self._failed)
        return False

    def _failed(self, err=None):
        if self.mode == "aside":
            return
        log("lost it:", err)
        self._drop()
        self.mode = "searching"
        self._later(2000, self._tick)

    def _drop(self):
        dev, ch = self.dev_path, self.chr_path
        self.dev_path = self.chr_path = None
        if ch:
            try:
                dbus.Interface(self.bus.get_object(BLUEZ, ch), CHR).StopNotify(reply_handler=lambda: None, error_handler=lambda e: None)
            except dbus.DBusException:
                pass
        if dev:
            try:
                dbus.Interface(self.bus.get_object(BLUEZ, dev), DEV).Disconnect(reply_handler=lambda: None, error_handler=lambda e: None)
            except dbus.DBusException:
                pass

    def _watchdog(self):
        if self.dev_path and self.mode in ("connecting", "live"):
            now = time.time()
            if self.last_value and now - self.last_value > STALL:
                self._failed("stalled")
            elif not self.last_value and self.chr_path and now - self.subscribed_at > FIRST_VALUE:
                self._failed("no first value")
        return True

    def _added(self, path, ifs):
        if DEV in ifs:
            self._note(path, ifs[DEV])

    def _props_changed(self, iface, changed, invalidated, path=None):
        if iface == DEV:
            if self.dev_path and path == self.dev_path and "Connected" in changed and not bool(changed["Connected"]):
                self.dev_path = self.chr_path = None
                if self.mode in ("connecting", "live"):
                    log("the sensor went away")
                    self.mode = "searching"
                    self._later(1000, self._tick)
                return
            if "RSSI" in changed or "UUIDs" in changed or "ManufacturerData" in changed or "ServiceData" in changed:
                self._note(path, changed)
        elif iface == CHR and self.chr_path and path == self.chr_path and "Value" in changed:
            bpm = parse_hrm(bytes(changed["Value"]))
            if bpm is None:
                return
            self.last_value = time.time()
            if self.mode != "live":
                self.mode = "live"
                log("live from", self.dev_name)
            self.site.reading(bpm)


def main():
    try:
        conf = load_conf()
    except FileNotFoundError:
        print(f"No link key: put one in {CONF_DIR}/key (health.ojee.net, Me, Connections, Console health module).", file=sys.stderr)
        sys.exit(2)
    log("relay", conf["source"], "to", conf["url"])
    Relay(conf).start()
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
