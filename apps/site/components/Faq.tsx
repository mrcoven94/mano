export default function Faq({ id = "questions", title = "Questions", intro, items }: { id?: string; title?: string; intro?: string; items: [string, string][] }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: items.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
        }).replace(/</g, "\\u003c") }}
      />
      <div className="wrap faq-grid">
        <div>
          <h2 id={`${id}-h`}>{title}</h2>
          {intro && <p className="lede" style={{ marginTop: 16, maxWidth: 380 }}>{intro}</p>}
        </div>
        <div className="faq-list">
          {items.map(([q, a], i) => (
            <details key={q} className="faq" open={i === 0}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
