const http = require('http'); const fs = require('fs'); const { WebSocketServer } = require('ws');
const img = fs.readFileSync(__dirname + '/frame.jpg'); const MB = 'abc123mock';
let t = 2400;
const status = () => ({ Status: { CurrentStatus: [1], TempOfNozzle: 219.6, TempTargetNozzle: 220, TempOfHotbed: 59.8, TempTargetHotbed: 60, TempOfBox: 34.2, TempTargetBox: 0,
  CurrentFanSpeed: { ModelFan: 100, AuxiliaryFan: 40, BoxFan: 20 },
  PrintInfo: { Status: 13, CurrentLayer: Math.floor(t/30), TotalLayer: 412, CurrentTicks: t, TotalTicks: 12360, Filename: 'Benchy_PLA_0.2mm.gcode', Progress: Math.round(t/12360*100), PrintSpeedPct: 100 } },
  MainboardID: MB, TimeStamp: Date.now()/1000|0, Topic: 'sdcp/status/' + MB });
const wss = new WebSocketServer({ port: 3030, path: '/websocket' });
wss.on('connection', s => {
  s.on('message', raw => { const m = raw.toString(); if (m === 'ping') return s.send('pong'); const r = JSON.parse(m); console.log('cmd', r.Data.Cmd, JSON.stringify(r.Data.Data));
    if (r.Data.Cmd === 0) s.send(JSON.stringify(status()));
    if (r.Data.Cmd === 1) s.send(JSON.stringify({ Attributes: { Name: 'Centauri Carbon', MachineName: 'Centauri Carbon', FirmwareVersion: 'V1.1.40' }, MainboardID: MB }));
    s.send(JSON.stringify({ Id: '', Data: { Cmd: r.Data.Cmd, Data: r.Data.Cmd === 386 ? { Ack: 0, VideoUrl: '127.0.0.1:3031/video' } : { Ack: 0 }, RequestID: r.Data.RequestID, MainboardID: MB }, Topic: 'sdcp/response/' + MB }));
  });
  const iv = setInterval(() => { t += 3; s.send(JSON.stringify(status())); }, 2000); s.on('close', () => clearInterval(iv));
});
http.createServer((q, res) => { res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' });
  const iv = setInterval(() => { res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${img.length}\r\n\r\n`); res.write(img); res.write('\r\n'); }, 200);
  q.on('close', () => clearInterval(iv)); }).listen(3031);
console.log('mock up');
