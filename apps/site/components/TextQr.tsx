import QRCode from "react-qr-code";
import { SMS_HREF, SMS_NUMBER } from "@/lib/site";

/* For people reading on a computer: scan with a phone to start a text. Hidden on phones, where the button works. */
export default function TextQr() {
  return (
    <div className="text-qr">
      <span className="text-qr-code">
        <QRCode value={SMS_HREF} size={112} aria-label="QR code that opens a text to Mano" />
      </span>
      <p>
        <b>On a computer?</b>
        Scan it with your phone camera, or text Mano at <a className="sms-num" href={SMS_HREF}>{SMS_NUMBER}</a>.
      </p>
    </div>
  );
}
