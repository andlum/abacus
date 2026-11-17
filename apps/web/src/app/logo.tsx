// The app's mark: a clementine with its leaf, on the grove green. The
// home-screen icon draws the same picture (icons/[file]/route.tsx), so the
// colours are written out here rather than taken from the theme.
export const MARK = {
  grove: "#13261F",
  peel: "#D9620C",
  clementine: "#F07A1A",
  marmalade: "#F5B43A",
  shine: "#FFC27A",
  leaf: "#3F8A4C",
};

// Drawn on a 100 × 100 grid. `tile` puts the grove square behind it.
export function ClementineMark({ size, className, tile = true }: { size?: number; className?: string; tile?: boolean }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden>
      {tile && <rect width="100" height="100" fill={MARK.grove} />}
      <circle cx="50" cy="56" r="31" fill={MARK.clementine} stroke={MARK.peel} strokeWidth="4" />
      <ellipse cx="38" cy="45" rx="8" ry="4.5" transform="rotate(-35 38 45)" fill={MARK.shine} />
      <circle cx="58" cy="66" r="1.6" fill={MARK.peel} />
      <circle cx="44" cy="70" r="1.6" fill={MARK.peel} />
      <circle cx="66" cy="52" r="1.6" fill={MARK.peel} />
      <path d="M50 26 C 50 22, 52 19, 54 17" fill="none" stroke={MARK.marmalade} strokeWidth="3" strokeLinecap="round" />
      <path d="M51 26 C 58 16, 72 14, 79 18 C 72 27, 60 29, 51 26 Z" fill={MARK.leaf} />
    </svg>
  );
}

// The header's mark: the fruit on its tile, with the name beside it on wider
// screens.
export function ClementineLogo({ className = "size-7 rounded-[8px]", wordmark = false }: { className?: string; wordmark?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <ClementineMark className={className} />
      {wordmark && <span className="wordmark hidden text-2xl leading-none sm:inline">clementine</span>}
    </span>
  );
}
