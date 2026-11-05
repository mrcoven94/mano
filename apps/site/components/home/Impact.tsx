/* Why Mano matters, in sourced numbers. Every figure links to the page it came from; nothing is rounded past what
   the source says. */
const FIGURES: { n: string; text: string; source: string; href: string }[] = [
  {
    n: "$60B+",
    text: "in benefits go unclaimed in the US every year, by Code for America\u2019s estimate.",
    source: "Code for America",
    href: "https://audaciousproject.org/grantees/code-for-america",
  },
  {
    n: "25 million",
    text: "people lost Medicaid in 2023 and 2024. 69% of them lost it over paperwork, not because they stopped qualifying.",
    source: "KFF",
    href: "https://www.kff.org/medicaid/medicaid-enrollment-and-unwinding-tracker/",
  },
  {
    n: "1 in 8",
    text: "people eligible for SNAP food benefits did not get them in 2022.",
    source: "USDA",
    href: "https://www.fns.usda.gov/research/snap/state-participation-rates/2022",
  },
  {
    n: "$95 billion",
    text: "in SNAP food benefits reached about 42 million people a month in 2025. Each one renews on a deadline.",
    source: "KFF, from USDA data",
    href: "https://www.kff.org/state-health-policy-data/state-indicator/total-snap-program-benefits/",
  },
];

export default function Impact() {
  return (
    <section className="h-impact" aria-labelledby="impact-h">
      <div className="wrap">
        <h2 id="impact-h">People lose help they qualify for over a missed letter.</h2>
        <ul className="h-impact-list">
          {FIGURES.map((f) => (
            <li key={f.n}>
              <b>{f.n}</b>
              <span>{f.text}</span>
              <a href={f.href}>{f.source}</a>
            </li>
          ))}
        </ul>
        <p className="lede">Mano reads the letter, holds the date and texts before it. For food benefits it fills out the renewal and files it after your yes. Today that filing goes to a test portal.</p>
      </div>
    </section>
  );
}
