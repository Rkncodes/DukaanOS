import qrcode from "qrcode-generator";

/** A real, scannable QR code of `value`, drawn as SVG (error correction M, with the quiet zone). */
export function QrCode({ value, size = 240, label }: { value: string; size?: number; label: string }) {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4; // modules of white margin a scanner needs
  let path = "";
  for (let row = 0; row < count; row++)
    for (let col = 0; col < count; col++) if (qr.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
  const side = count + quiet * 2;

  return (
    <svg
      role="img"
      aria-label={label}
      data-value={value}
      width={size}
      height={size}
      viewBox={`0 0 ${side} ${side}`}
      shapeRendering="crispEdges"
    >
      <rect width={side} height={side} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
