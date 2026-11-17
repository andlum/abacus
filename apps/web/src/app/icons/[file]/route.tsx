import { ImageResponse } from "next/og";
import { ClementineMark, MARK } from "../../logo";

// The app's icon, drawn at each size the home screen asks for: the
// clementine and its leaf on the grove green. Paths end in .png so the
// proxy lets them through signed out, as the install prompt needs.
const SIZES: Record<string, number> = { "192.png": 192, "512.png": 512, "apple-touch.png": 180 };

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(SIZES).map((file) => ({ file }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const size = SIZES[(await params).file]!;
  // The fruit sits inside the middle 80% so a round or squircle mask
  // (Android's "maskable" icons) never clips the leaf.
  const inner = Math.round(size * 0.8);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: MARK.grove }}>
        <ClementineMark size={inner} tile={false} />
      </div>
    ),
    { width: size, height: size },
  );
}
