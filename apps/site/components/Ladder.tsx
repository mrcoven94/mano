import Image from "next/image";

/* Getting through, getting steady, getting ahead. */
const steps = [
  { art: "/art/groceries.svg", title: "Get through this month", text: "Food, rent and the power bill, handled fast." },
  { art: "/art/stroller.svg", title: "Get steady", text: "Child care, health coverage and rides, so work and family fit." },
  { art: "/art/climb.svg", title: "Get ahead", text: "Credit, job training and school. Mano keeps going after the crisis." },
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
        </li>
      ))}
    </ol>
  );
}
