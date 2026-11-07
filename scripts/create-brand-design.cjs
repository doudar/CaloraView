// Original editable Caloraview artwork: rendered by Skarix MCP, not a stock icon.
const fs = require('node:fs');
const path = require('node:path');
function arc(id, outer, inner, fill, gradient) {
  const points = [];
  for (let i = 0; i <= 64; i++) { const a = (45 + i * 270 / 64) * Math.PI / 180; points.push({ x: .5 + outer * Math.cos(a) / 100, y: .5 + outer * Math.sin(a) / 100 }); }
  for (let i = 64; i >= 0; i--) { const a = (45 + i * 270 / 64) * Math.PI / 180; points.push({ x: .5 + inner * Math.cos(a) / 100, y: .5 + inner * Math.sin(a) / 100 }); }
  return { id: id.toLowerCase().replaceAll(' ', '-'), name: id, kind: 'draw', x: 0, y: 0, width: 100, height: 100, points, closed: true, fill, stroke: 'transparent', strokeWidth: 0, ...(gradient ? { gradient } : {}) };
}
const elements = [
  { id: 'background', name: 'Graphite rounded tile', kind: 'shape', shape: 'rectangle', x: 2, y: 2, width: 96, height: 96, cornerRadius: 22, fill: '#101823', stroke: 'transparent', strokeWidth: 0 },
  arc('Outer thermal contour', 34, 27, '#ed553e', { from: '#a83278', to: '#ff713f' }),
  arc('Middle thermal contour', 23, 17, '#ffb149', { from: '#ff713f', to: '#ffd26a' }),
  { id: 'hotspot', name: 'Thermal target square', kind: 'shape', shape: 'rectangle', x: 45, y: 45, width: 10, height: 10, fill: 'transparent', stroke: '#fff0c4', strokeWidth: 1.8 },
  { id: 'view-reticle', name: 'Target left tick', kind: 'shape', shape: 'rectangle', x: 39, y: 49.1, width: 6, height: 1.8, fill: '#fff0c4', stroke: 'transparent', strokeWidth: 0 },
  { id: 'view-reticle-v', name: 'Target top tick', kind: 'shape', shape: 'rectangle', x: 49.1, y: 39, width: 1.8, height: 6, fill: '#fff0c4', stroke: 'transparent', strokeWidth: 0 },
  { id: 'target-right', name: 'Target right tick', kind: 'shape', shape: 'rectangle', x: 55, y: 49.1, width: 6, height: 1.8, fill: '#fff0c4', stroke: 'transparent', strokeWidth: 0 },
  { id: 'target-bottom', name: 'Target bottom tick', kind: 'shape', shape: 'rectangle', x: 49.1, y: 55, width: 1.8, height: 6, fill: '#fff0c4', stroke: 'transparent', strokeWidth: 0 },
];
const request = { workspace: 'stickers', name: 'Caloraview — thermal lens app icon', canvas: { width: 100, height: 100, background: 'transparent' }, copies: 1, elements };
const output = path.resolve('assets/brand'); fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'skarix-design.json'), JSON.stringify(request, null, 2));
console.log('Created editable Skarix MCP design request.');
