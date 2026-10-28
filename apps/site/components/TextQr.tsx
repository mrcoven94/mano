import QRCode from "react-qr-code";
import { SMS_HREF } from "@/lib/site";

export default function TextQr({ size = 168 }: { size?: number }) {
  return (
    <div className="text-qr">
      <QRCode value={SMS_HREF} size={size} aria-label="QR code that opens a text to Mano" />
      <p className="note">Point your camera to text Mano.</p>
    </div>
  );
}
