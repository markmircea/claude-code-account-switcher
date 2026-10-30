// Builds the VS Code status bar extension package (.vsix): a zip in the exact layout `code --install-extension`
// reads. It replaced vscode/pack.py, so npm installs need no Python and no hunting for the vscode/ folder.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VS = path.join(HERE, '..', 'vscode');

// CRC-32 with our own table (polynomial 0xEDB88320): zlib.crc32 only exists from Node 20.15 and we claim >= 20.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

// Joined with '\n' on purpose - the manifest is a fixed string, so the source file's line endings must not leak in.
function manifestText(pkg) {
  return `${[
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">',
    '  <Metadata>',
    `    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />`,
    `    <DisplayName>${pkg.displayName}</DisplayName>`,
    `    <Description xml:space="preserve">${pkg.description}</Description>`,
    '    <Categories>Other</Categories>',
    '    <Properties>',
    `      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}" />`,
    '    </Properties>',
    '  </Metadata>',
    '  <Installation>',
    '    <InstallationTarget Id="Microsoft.VisualStudio.Code" />',
    '  </Installation>',
    '  <Dependencies />',
    '  <Assets>',
    '    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />',
    '  </Assets>',
    '</PackageManifest>',
  ].join('\n')}\n`;
}

function contentTypesText() {
  return `${[
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '  <Default Extension=".json" ContentType="application/json" />',
    '  <Default Extension=".js" ContentType="application/javascript" />',
    '  <Default Extension=".vsixmanifest" ContentType="text/xml" />',
    '</Types>',
  ].join('\n')}\n`;
}

export function buildVsix(outDir) {
  const pkgPath = path.join(VS, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const entries = [
    { name: 'extension.vsixmanifest', data: Buffer.from(manifestText(pkg), 'utf8') },
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesText(), 'utf8') },
    { name: 'extension/package.json', data: fs.readFileSync(pkgPath) },
    { name: 'extension/extension.js', data: fs.readFileSync(path.join(VS, 'extension.js')) },
  ];

  const { time, date } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const comp = zlib.deflateRawSync(e.data);
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);            // local file header signature
    lh.writeUInt16LE(20, 4);                    // version needed
    lh.writeUInt16LE(0, 6);                     // flags
    lh.writeUInt16LE(8, 8);                     // method: deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);                    // extra length
    locals.push(Buffer.concat([lh, name, comp]));
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);            // central directory header signature
    ch.writeUInt16LE(20, 4);                    // version made by
    ch.writeUInt16LE(20, 6);                    // version needed
    ch.writeUInt16LE(0, 8);                     // flags
    ch.writeUInt16LE(8, 10);                    // method: deflate
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);                    // extra length
    ch.writeUInt16LE(0, 32);                    // comment length
    ch.writeUInt16LE(0, 34);                    // disk number start
    ch.writeUInt16LE(0, 36);                    // internal attributes
    ch.writeUInt32LE(0, 38);                    // external attributes
    ch.writeUInt32LE(offset, 42);               // this entry's local header offset
    centrals.push(Buffer.concat([ch, name]));
    offset += lh.length + name.length + comp.length;
  }
  const body = Buffer.concat(locals);
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);            // end of central directory signature
  eocd.writeUInt16LE(0, 4);                     // disk number
  eocd.writeUInt16LE(0, 6);                     // central directory disk
  eocd.writeUInt16LE(entries.length, 8);        // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);       // total entries
  eocd.writeUInt32LE(cd.length, 12);            // central directory size
  eocd.writeUInt32LE(body.length, 16);          // central directory offset
  eocd.writeUInt16LE(0, 20);                    // comment length

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${pkg.name}-${pkg.version}.vsix`);
  fs.writeFileSync(file, Buffer.concat([body, cd, eocd]));
  return file;
}

export function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`not a zip: bad central directory entry at ${p}`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lho = buf.readUInt32LE(p + 42);
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`${name}: bad local file header at ${lho}`);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 8) data = zlib.inflateRawSync(raw);
    else if (method === 0) data = Buffer.from(raw);
    else throw new Error(`${name}: unsupported zip method ${method}`);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC-32 mismatch (got 0x${crc32(data).toString(16)}, want 0x${crc.toString(16)})`);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
