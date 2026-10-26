const Row = ({ dot, name, chip, chipColor }: { dot: string; name: string; chip: string; chipColor?: string }) => (
  <div className="mini-row rise">
    <span><span className="dot" style={{ background: dot }} />{name}</span>
    <span className="chip" style={chipColor ? { background: chipColor, color: "#141414", borderColor: "transparent" } : undefined}>{chip}</span>
  </div>
);

export default function Bento() {
  return (
    <div className="bento">
      <article className="card w7">
        <div className="viz" aria-hidden="true">
          <div className="mini">
            <Row dot="var(--green)" name="Food assistance" chip="Applied" chipColor="var(--green)" />
            <Row dot="var(--orange)" name="Help with the power bill" chip="Waiting for your yes" chipColor="var(--orange)" />
            <Row dot="var(--blue)" name="Job training scholarship" chip="You may qualify" />
          </div>
        </div>
        <div className="copy"><h3>Apply for help</h3><p>Benefits, cash assistance, jobs, scholarships and training. Mano finds what you may qualify for and applies once you say yes.</p></div>
      </article>

      <article className="card w5">
        <div className="viz" aria-hidden="true">
          <div className="letter read" style={{ width: 230, transform: "rotate(2deg)", padding: "14px 14px" }}>
            <div className="lh" style={{ fontSize: ".62rem" }}>NOTICE OF RENEWAL</div>
            <div className="ln" style={{ width: "90%" }} /><div className="ln" style={{ width: "70%" }} />
            <div className="hl" style={{ fontSize: ".66rem" }}>Due November 18</div>
            <div className="ln" style={{ width: "84%" }} /><div className="ln" style={{ width: "56%" }} />
          </div>
        </div>
        <div className="copy"><h3>Read your mail</h3><p>Send a photo of any letter. Mano tells you what it wants and when it is due.</p></div>
      </article>

      <article className="card">
        <div className="viz" aria-hidden="true">
          <div className="form">
            <div><label>Name</label><div className="f"><span>Maria Lopez</span></div></div>
            <div><label>Monthly income</label><div className="f"><span><span className="flag">$2,140</span> (check this)</span></div></div>
            <div><label>People in your home</label><div className="f"><span>3</span></div></div>
          </div>
        </div>
        <div className="copy"><h3>Fill out any form</h3><p>Paper or online. Mano fills it in from what you already shared and shows you the finished copy.</p></div>
      </article>

      <article className="card">
        <span className="chip tag">Plus</span>
        <div className="viz" aria-hidden="true">
          <div style={{ textAlign: "center" }}>
            <div className="timer">47:12</div>
            <div className="mono" style={{ marginTop: 8 }}>On hold for you</div>
            <div className="wave live" style={{ justifyContent: "center" }}>{Array.from({ length: 22 }, (_, k) => <i key={k} />)}</div>
          </div>
        </div>
        <div className="copy"><h3>Wait on hold</h3><p>Mano stays on the line and calls you when a person answers. It always says it is your automated assistant.</p></div>
      </article>

      <article className="card">
        <div className="viz" aria-hidden="true">
          <div>
            <div className="mono" style={{ marginBottom: 10 }}>November</div>
            <div className="cal">
              {Array.from({ length: 21 }, (_, k) => {
                const d = k + 1;
                return <span key={k} className={d === 18 ? "due" : d === 4 ? "start" : undefined}>{d}</span>;
              })}
            </div>
          </div>
        </div>
        <div className="copy"><h3>Renew on time</h3><p>Mano starts your renewal two weeks early, so your help does not stop over a missed date.</p></div>
      </article>

      <article className="card">
        <div className="viz" aria-hidden="true">
          <div className="mini">
            <Row dot="var(--orange)" name="Renewal form" chip="Nov 18" />
            <Row dot="var(--blue)" name="School meal form" chip="Dec 2" />
            <Row dot="var(--green)" name="Rent help receipt" chip="Done" />
          </div>
        </div>
        <div className="copy"><h3>Track every deadline</h3><p>One list of what is due, what was sent and what came back, with a reminder before anything is late.</p></div>
      </article>

      <article className="card">
        <div className="viz" aria-hidden="true">
          <div className="sms">
            <div className="b them anim" style={{ margin: 0 }}><div style={{ maxWidth: "100%" }}>New opening: front desk at a clinic, 2 miles away, $19 an hour. Want me to draft the application?</div></div>
            <div className="b me" style={{ margin: 0 }}><div>Yes</div></div>
          </div>
        </div>
        <div className="copy"><h3>Job updates by text</h3><p>Mano watches for openings that fit you, drafts the application and texts you when it needs your yes.</p></div>
      </article>

      <article className="card">
        <div className="viz" aria-hidden="true">
          <div className="lang">
            <div className="b them"><div lang="es">Sus beneficios se renuevan el 18 de noviembre.</div></div>
            <div className="b them"><div lang="vi">Trợ cấp của bạn sẽ được gia hạn vào ngày 18 tháng 11.</div></div>
            <div className="b them"><div>Your benefits renew on November 18.</div></div>
          </div>
        </div>
        <div className="copy"><h3>Any language</h3><p>Text Mano in the language you speak at home. It explains every letter in that language too.</p></div>
      </article>
    </div>
  );
}
