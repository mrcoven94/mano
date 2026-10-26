import Image from "next/image";

/* Getting through, getting steady, getting ahead. */
const steps = [
  { art: "/art/groceries.svg", title: "Get through this month", text: "Food, rent and the power bill, handled fast, so a hard month stays a hard month and not a hard year.", tags: ["Food help", "Rent help", "Bill help"] },
  { art: "/art/stroller.svg", title: "Get steady", text: "Child care, health coverage and rides, so work and family fit together.", tags: ["Child care", "Health coverage", "Transit"] },
  { art: "/art/climb.svg", title: "Get ahead", text: "Credit, job training, scholarships and savings. Mano keeps going after the crisis is over.", tags: ["Credit", "Job training", "Scholarships"] },
];

export default function Ladder() {
  return (
    <ol className="ladder" role="list">
      {steps.map((s, i) => (
        <li key={s.title} className="rung">
          <div className="art"><Image src={s.art} width={480} height={360} alt="" unoptimized /></div>
          <span className="rung-n">Step {i + 1}</span>
          <h3>{s.title}</h3>
          <p>{s.text}</p>
          <ul className="rung-tags" role="list">{s.tags.map((t) => <li key={t}>{t}</li>)}</ul>
        </li>
      ))}
    </ol>
  );
}
