export default function Faq({ items }: { items: [string, string][] }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {items.map(([q, a]) => (
        <details key={q} className="faq">
          <summary>{q}</summary>
          <p>{a}</p>
        </details>
      ))}
    </div>
  );
}
