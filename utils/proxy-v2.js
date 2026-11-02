'use strict';
const net = require('node:net');
const tls = require('node:tls');
const { canonicalIP, trustedPeer } = require('./admin-state');
const SIGNATURE = Buffer.from('0d0a0d0a000d0a515549540a', 'hex');

function parse(buffer) {
    if (!buffer.subarray(0, Math.min(12, buffer.length)).equals(SIGNATURE.subarray(0, Math.min(12, buffer.length)))) {
        throw new Error('Invalid PROXY signature');
    }
    if (buffer.length < 16) { return null; }
    const length = buffer.readUInt16BE(14);
    if (buffer[12] !== 0x21 || ![0x11, 0x21].includes(buffer[13]) || length > 512) { throw new Error('Invalid PROXY header'); }
    const addressLength = buffer[13] === 0x11 ? 12 : 36;
    if (length < addressLength) { throw new Error('Short PROXY address'); }
    if (buffer.length < 16 + length) { return null; }
    // Validate TLV framing even though no TLV may change authentication identity.
    let offset = 16 + addressLength;
    while (offset < 16 + length) {
        if (offset + 3 > 16 + length) { throw new Error('Short PROXY TLV'); }
        const size = buffer.readUInt16BE(offset + 1);
        offset += 3 + size;
        if (offset > 16 + length) { throw new Error('Oversized PROXY TLV'); }
    }
    const source = buffer[13] === 0x11 ? [...buffer.subarray(16, 20)].join('.')
        : Array.from({ length: 8 }, (_, i) => buffer.readUInt16BE(16 + i * 2).toString(16)).join(':');
    return { address: canonicalIP(source), remaining: buffer.subarray(16 + length) };
}

function proxyServer(options, ranges, accept, { timeout = 3000, maximum = 128 } = {}) {
    if (!ranges?.length) { throw new Error('PROXY mode requires trusted peer CIDRs'); }
    ranges.forEach(range => require('ipaddr.js').parseCIDR(range));
    // Feed the original socket to a real TLS server after consuming only the PROXY
    // frame. This retains Node's handshake timeout and setSecureContext reload path.
    const secure = tls.createServer({ ...options, handshakeTimeout: 5000 }, accept);
    secure.on('tlsClientError', () => {});
    let pending = 0;
    const server = net.createServer(socket => {
        if (pending >= maximum || !trustedPeer(socket.remoteAddress, ranges)) { socket.destroy(); return; }
        pending++;
        let bytes = Buffer.alloc(0);
        const timer = setTimeout(() => socket.destroy(), timeout);
        const cleanup = () => {
            clearTimeout(timer); pending--;
            socket.removeListener('data', data);
            socket.removeListener('close', cleanup);
        };
        const data = chunk => {
            try {
                // One bounded header plus at most the socket read chunk of TLS data.
                bytes = Buffer.concat([bytes, chunk]);
                const header = parse(bytes);
                if (!header) { return; }
                socket.pause();
                cleanup();
                socket.verifiedAddress = header.address;
                if (header.remaining.length) { socket.unshift(header.remaining); }
                secure.emit('connection', socket);
                socket.resume();
            }
            catch { socket.destroy(); }
        };
        socket.on('data', data);
        socket.once('close', cleanup);
    });
    server.setSecureContext = options => secure.setSecureContext(options);
    return server;
}
module.exports = { parse, proxyServer, SIGNATURE };
