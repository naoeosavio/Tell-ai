import { useEffect, useState } from 'react';

/**
 * Animated ASCII logo cycling through the 5 variants documented in `tell.md`
 * (TELL AI / SDK / CORE / CLI / WEB). Pure presentational — no network, no secrets.
 *
 * NOTE: block/box-drawing glyphs (█ ═ ║ ╔ ╝…) only align under a true
 * monospace font WITH box-drawing coverage. The system `monospace` fallback
 * on minimal systems often substitutes a proportional font per-glyph, which
 * garbles the art — hence the explicit stack below (DejaVu Sans Mono covers
 * these glyphs at uniform advance width) plus ligature/kerning kills.
 */

const FRAMES: Array<{ label: string; art: string }> = [
  {
    label: 'TELL AI',
    art: [
      '████████╗███████╗██╗     ██╗        █████╗ ██╗',
      '╚══██╔══╝██╔════╝██║     ██║       ██╔══██╗██║',
      '   ██║   █████╗  ██║     ██║       ███████║██║',
      '   ██║   ██╔══╝  ██║     ██║       ██╔══██║██║',
      '   ██║   ███████╗███████╗███████╗  ██║  ██║██║',
    ].join('\n'),
  },
  {
    label: 'TELL SDK',
    art: [
      '████████╗███████╗██╗     ██╗       ███████╗██████╗ ██╗  ██╗',
      '╚══██╔══╝██╔════╝██║     ██║       ██╔════╝██╔══██╗██║ ██╔╝',
      '   ██║   █████╗  ██║     ██║       ███████╗██║  ██║█████╔╝ ',
      '   ██║   ██╔══╝  ██║     ██║       ╚════██║██║  ██║██╔═██╗ ',
      '   ██║   ███████╗███████╗███████╗  ███████║██████╔╝██║  ██╗',
    ].join('\n'),
  },
  {
    label: 'TELL CORE',
    art: [
      '████████╗███████╗██╗     ██╗        ██████╗  ██████╗  ██████╗ ███████╗',
      '╚══██╔══╝██╔════╝██║     ██║       ██╔════╝ ██╔═══██╗ ██╔══██╗██╔════╝',
      '   ██║   █████╗  ██║     ██║       ██║      ██║   ██║ ██████╔╝█████╗  ',
      '   ██║   ██╔══╝  ██║     ██║       ██║      ██║   ██║ ██╔══██╗██╔══╝  ',
      '   ██║   ███████╗███████╗███████╗  ╚██████╗ ╚██████╔╝ ██║  ██║███████╗',
    ].join('\n'),
  },
  {
    label: 'TELL CLI',
    art: [
      '████████╗███████╗██╗     ██╗        ██████╗██╗     ██╗',
      '╚══██╔══╝██╔════╝██║     ██║       ██╔════╝██║     ██║',
      '   ██║   █████╗  ██║     ██║       ██║     ██║     ██║',
      '   ██║   ██╔══╝  ██║     ██║       ██║     ██║     ██║',
      '   ██║   ███████╗███████╗███████╗  ╚██████╗███████╗██║',
    ].join('\n'),
  },
  {
    label: 'TELL WEB',
    art: [
      '████████╗███████╗██╗     ██╗       ██╗    ██╗███████╗██████╗ ',
      '╚══██╔══╝██╔════╝██║     ██║       ██║    ██║██╔════╝██╔══██╗',
      '   ██║   █████╗  ██║     ██║       ██║ █╗ ██║█████╗  ██████╔╝',
      '   ██║   ██╔══╝  ██║     ██║       ██║███╗██║██╔══╝  ██╔══██╗',
      '   ██║   ███████╗███████╗███████╗  ╚███╔███╔╝███████╗██████╔╝',
    ].join('\n'),
  },
];

const FRAME_MS = 2000;

/** Monospace stack with guaranteed box-drawing coverage at uniform width. */
const LOGO_FONT_STACK =
  '"DejaVu Sans Mono","Noto Sans Mono","JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace';

export default function TellLogoLoop() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % FRAMES.length), FRAME_MS);
    return () => clearInterval(id);
  }, []);

  const frame = FRAMES[index] ?? FRAMES[0];
  if (!frame) return null;

  return (
    <div className="select-none w-full" role="img" aria-label="Tell logo">
      {/* container-type lets the art scale with the card: the widest frame
          (TELL CORE, 73 columns) must never overflow the login card. */}
      <div className="overflow-x-auto logo-scroll" style={{ containerType: 'inline-size' }}>
        <pre
          aria-hidden="true"
          className="w-max mx-auto text-[9px] text-(--color-accent-text) whitespace-pre"
          style={{
            fontFamily: LOGO_FONT_STACK,
            // 73 columns * 0.6em advance: 2.25cqw keeps the widest frame
            // inside the container (fallback to the 9px class if cqw is
            // unsupported and the declaration is dropped).
            fontSize: 'min(10px, 2.25cqw)',
            letterSpacing: '0',
            wordSpacing: '0',
            lineHeight: 1.35,
            fontKerning: 'none',
            fontVariantLigatures: 'none',
            fontFeatureSettings: '"liga" 0, "calt" 0',
          }}
        >
          {frame.art}
        </pre>
      </div>
      <div className="mt-2 flex items-center justify-center gap-1.5" aria-hidden="true">
        {FRAMES.map((f, i) => (
          <span
            key={`${f.label}-${i}`}
            className={`h-1 w-6 transition-colors ${i === index ? 'bg-(--color-accent)' : 'bg-white/10'}`}
          />
        ))}
      </div>
      <p className="sr-only">{frame.label}</p>
    </div>
  );
}
