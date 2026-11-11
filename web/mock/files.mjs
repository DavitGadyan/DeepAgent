/** Stand-in application files (PDF, PNG preview, cover letter) built without dependencies. */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A greyscale "page": white, with grey bars where the lines of a CV would be. */
function cvPreviewPng() {
  const [width, height] = [420, 594];
  const rows = Buffer.alloc((width + 1) * height, 0xff);
  for (let y = 0; y < height; y += 1) {
    rows[y * (width + 1)] = 0; // filter type: none
    const heading = y > 36 && y < 56;
    const textLine = y > 90 && y < 560 && y % 18 < 6;
    if (!heading && !textLine) continue;
    const end = heading ? 220 : 380 - ((y * 37) % 110);
    rows.fill(heading ? 0x30 : 0xb4, y * (width + 1) + 1 + 36, y * (width + 1) + 1 + end);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A one-page PDF with a single line of text. */
function cvPdf(title) {
  const stream = `BT /F1 16 Tf 60 760 Td (Tailored CV: ${title.replaceAll(/[()\\]/g, '')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** @returns `{ type, body }` for a file of the lead's application folder, or null. */
export function applicationFile(lead, name) {
  if (!lead.application?.files.includes(name)) return null;
  if (name.endsWith('.png')) return { type: 'image/png', body: cvPreviewPng() };
  if (name.endsWith('.pdf')) return { type: 'application/pdf', body: cvPdf(lead.title) };
  return {
    type: 'text/plain; charset=utf-8',
    body: Buffer.from(
      `Dear ${lead.company} team,\n\nI am applying for the ${lead.title} role.\n\n(mock cover letter)\n`,
    ),
  };
}
