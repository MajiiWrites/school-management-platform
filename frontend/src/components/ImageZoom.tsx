// Zoomable image viewer for OCR / photo-import review screens: the admin
// reads the original photo next to the extracted rows and zooms in to
// check a spelling or a time. Zoom is a width percentage inside a
// scrollable frame — no extra libraries.
import { useState } from 'react';
import { Button } from './ui';

export default function ImageZoom({ src, alt }: { src: string; alt: string }) {
  const [zoom, setZoom] = useState(1);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}>− Zoom out</Button>
        <span className="min-w-12 text-center text-sm font-medium text-slate-700">{Math.round(zoom * 100)}%</span>
        <Button variant="secondary" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}>+ Zoom in</Button>
        <Button variant="ghost" onClick={() => setZoom(1)}>Reset</Button>
        <input
          type="range"
          min={0.5}
          max={3}
          step={0.25}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="w-32 accent-brand-700"
          aria-label="Zoom level"
        />
      </div>
      <div className="mt-2 max-h-[70vh] overflow-auto rounded-lg border border-slate-200 bg-slate-100">
        <img
          src={src}
          alt={alt}
          style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}
          className="block"
        />
      </div>
      <p className="mt-1 text-xs text-slate-500">Zoom in to check a name or time against the photo — nothing is saved until you confirm.</p>
    </div>
  );
}
