// Minimal RFC 6455 WebSocket server helper — just enough for loremaster:
// the browser sends binary audio frames + tiny text control frames, the server
// sends small text (JSON) frames back. No permessage-deflate, no fragmentation
// reassembly beyond what a browser sends for these small frames. Avoids adding
// the `ws` dependency for a single-purpose socket.

import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Attach to an http server's "upgrade" event. `onConnection(socket, req)` gets a
// tiny connection object with .on("message"|"close"), .sendJSON(obj), .close().
export function handleUpgrade(req, socket, onConnection) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const listeners = { message: [], close: [] };
  const emit = (ev, ...a) => listeners[ev].forEach((f) => f(...a));
  const conn = {
    on(ev, fn) { listeners[ev]?.push(fn); return conn; },
    sendJSON(obj) { sendText(socket, JSON.stringify(obj)); },
    sendText(str) { sendText(socket, str); },
    close() { try { socket.end(encodeFrame(0x8, Buffer.alloc(0))); } catch {} },
  };

  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const frame = decodeFrame(buf);
      if (!frame) break;
      buf = frame.rest;
      if (frame.opcode === 0x8) { emit("close"); conn.close(); return; } // close
      if (frame.opcode === 0x9) { socket.write(encodeFrame(0xA, frame.payload)); continue; } // ping->pong
      if (frame.opcode === 0x1) { emit("message", { type: "text", data: frame.payload.toString("utf8") }); }
      else if (frame.opcode === 0x2) { emit("message", { type: "binary", data: frame.payload }); }
    }
  });
  socket.on("close", () => emit("close"));
  socket.on("error", () => emit("close"));

  onConnection(conn, req);
}

// Decode one frame from the head of `data`. Returns null if incomplete.
// Client frames are always masked. Returns { opcode, payload, rest }.
function decodeFrame(data) {
  if (data.length < 2) return null;
  const opcode = data[0] & 0x0f;
  const masked = (data[1] & 0x80) !== 0;
  let len = data[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (data.length < offset + 2) return null;
    len = data.readUInt16BE(offset); offset += 2;
  } else if (len === 127) {
    if (data.length < offset + 8) return null;
    // 64-bit length; realistically audio frames are small, take the low 32 bits.
    len = Number(data.readBigUInt64BE(offset)); offset += 8;
  }
  const maskLen = masked ? 4 : 0;
  if (data.length < offset + maskLen + len) return null;
  let payload;
  if (masked) {
    const mask = data.subarray(offset, offset + 4);
    offset += 4;
    payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = data[offset + i] ^ mask[i & 3];
  } else {
    payload = data.subarray(offset, offset + len);
  }
  offset += len;
  return { opcode, payload, rest: data.subarray(offset) };
}

// Encode a server->client frame (unmasked, single fragment).
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendText(socket, str) {
  try { socket.write(encodeFrame(0x1, Buffer.from(str, "utf8"))); } catch {}
}
