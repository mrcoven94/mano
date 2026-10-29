import QRCode from "react-qr-code";
import { SMS_HREF } from "@/lib/site";

/* For people reading on a computer: scan with a phone to start a text. Hidden on phones, where the button works. */
export default function TextQr({ size = 112 }: { size?: number }) {
  return (
    <div className="text-qr">
      <span className="text-qr-code">
        <QRCode value={SMS_HREF} size={size} aria-label="QR code that opens a text to Mano" />
      </span>
      <p>
        <b>On a computer?</b>
        Scan it with your phone camera to text Mano.
      </p>
    </div>
  );
}
