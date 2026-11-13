# Centauri Monitor

A clean, read-only dashboard for the **Elegoo Centauri Carbon**: a big camera feed plus status, progress, time remaining, temperatures and fans. No controls — it can't move, heat or stop anything.

Plain HTML/CSS/JS, no build step.

## Run it

The page must be served over **plain HTTP** on your LAN (browsers block `ws://` from `https://` pages).

**Any static server**
```bash
npx http-server . -p 8080
```
Open `http://<this-machine>:8080/?printer=<printer-ip>`. The IP is remembered; change it later via the gear icon.

**Docker**
```bash
docker build -t centauri-monitor . && docker run -d --restart unless-stopped -p 8080:80 centauri-monitor
```

Opening `index.html` directly from disk also works in most browsers.

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
