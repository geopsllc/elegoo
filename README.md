# Centauri Monitor

A clean, read-only dashboard for the **Elegoo Centauri Carbon**: a big camera feed plus status, progress, time remaining, temperatures and fans. No controls — it can't move, heat or stop anything.

Plain HTML/CSS/JS, no build step.

## Deploy behind Apache (HTTPS, recommended)

The page is served over HTTPS and Apache proxies the printer, so it works remotely while the printer stays on a private address.

```bash
sudo git clone https://github.com/<you>/<repo>.git /var/www/centauri-dashboard
sudo a2enmod ssl proxy proxy_http proxy_wstunnel headers
sudo htpasswd -c /var/www/centauri-dashboard/.htpasswd <username>
sudo cp /var/www/centauri-dashboard/deploy/apache-vhost.conf /etc/apache2/sites-available/centauri.conf
```

Edit `centauri.conf` (hostname, cert paths, printer IP), then:

```bash
sudo a2ensite centauri && sudo apachectl configtest && sudo systemctl reload apache2
```

`.htpasswd` lives in the repo folder, is git-ignored, and the vhost refuses to serve it.

Update later with `git pull` in `/var/www/centauri-dashboard`.

Proxy mode is automatic on HTTPS pages: the browser uses `./printer/ws` and `./printer/video` on the same host. Force it on or off with `?proxy` / `?proxy=0`.

> **Keep the auth on.** The proxied WebSocket accepts every SDCP command (start/stop/delete), not just the read-only ones this page sends. Anyone who can reach it can control the printer.

Give the printer a DHCP reservation so its IP doesn't change.

## Run it directly on the LAN (no proxy)

Serve the folder over plain HTTP and open `http://<server>/?printer=<printer-ip>`. The browser then connects to the printer itself; the IP is remembered and can be changed via the gear icon.

Shortcuts: `F` or double-click the camera for fullscreen.

## How it talks to the printer

The Centauri Carbon speaks **SDCP v3** (the same protocol the slicer uses) over WebSocket.

| What | Where |
|---|---|
| Control/status | `ws://<ip>:3030/websocket`, JSON frames, plain-text `ping` → `pong` keep-alive |
| Camera | MJPEG at `http://<ip>:3031/video`, enabled by Cmd `386` `{"Enable":1}` |

Request envelope:
```json
{ "Id": "", "Topic": "sdcp/request/<MainboardID>",
  "Data": { "Cmd": 0, "Data": {}, "RequestID": "…", "MainboardID": "<id>", "TimeStamp": 1700000000, "From": 0 } }
```
Commands used: `0` status, `1` attributes, `386` enable video. The printer also pushes `sdcp/status/<id>` frames on its own.

Useful status fields: `CurrentStatus[0]`, `PrintInfo.{Status, Filename, Progress, CurrentLayer, TotalLayer, CurrentTicks, TotalTicks, PrintSpeedPct}` (ticks are seconds), `TempOfNozzle/TempTargetNozzle`, `TempOfHotbed/TempTargetHotbed`, `TempOfBox`, `CurrentFanSpeed.{ModelFan, AuxiliaryFan, BoxFan}`.

Note: the printer only allows a few simultaneous camera viewers; extra viewers see "Camera busy".

## Development

`dev/` contains a mock printer (WebSocket + MJPEG) for working without hardware:
```bash
cd dev && npm install && npm start
```
Then open the dashboard with `?printer=127.0.0.1`.

Protocol details were cross-checked against [elegoo-homeassistant](https://github.com/danielcherubini/elegoo-homeassistant).
