import Mascot from "./Mascot";
import { Browser, IPhone } from "./Devices";

/* One conversation that moves between the web and a phone. Every name and place is made up. */
const web: { who: "you" | "mano"; text: string }[] = [
  { who: "you", text: "Can you check on my child care application?" },
  { who: "mano", text: "Approved this morning. Care is covered starting Monday." },
  { who: "you", text: "Which places are near my job?" },
  { who: "mano", text: "3 are close. The one on Pine Street has an opening at 7:30." },
];

const phone: { who: "you" | "mano"; text: string }[] = [
  { who: "you", text: "Book the Pine Street tour for Thursday" },
  { who: "mano", text: "Booked for Thursday at 4. I added it to your calendar." },
];

function Bubbles({ items }: { items: typeof web }) {
  return (
    <ol className="ev-bubbles">
      {items.map((m, i) => <li key={i} className={`ev-msg ${m.who}`}><p>{m.text}</p></li>)}
    </ol>
  );
}

export default function Everywhere() {
  return (
    <div className="ev-stage">
      <Browser className="ev-browser">
        <div className="ev-app">
          <aside className="ev-side" aria-hidden="true">
            <span className="ev-brand"><Mascot size={22} tile tone="orange" />Mano</span>
            <span className="ev-nav on">Messages</span>
            <span className="ev-nav">Applications</span>
            <span className="ev-nav">Documents</span>
            <span className="ev-nav">Deadlines</span>
          </aside>
          <div className="ev-chat">
            <p className="ev-day">Today</p>
            <Bubbles items={web} />
          </div>
        </div>
      </Browser>
      <IPhone className="ev-phone">
        <div className="im-head small"><span /><span className="im-who"><Mascot size={30} tile tone="orange" /><small>Mano ›</small></span><span /></div>
        <div className="ev-phone-thread">
          <Bubbles items={web.slice(2)} />
          <p className="ev-day">Later, on your phone</p>
          <Bubbles items={phone} />
        </div>
      </IPhone>
    </div>
  );
}
