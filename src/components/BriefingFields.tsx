import type { Briefing } from "@/lib/types";
import Field from "./Field";

const LEVELS = ["L4", "L5", "L6", "Staff"];
export default function BriefingFields({ briefing, update, flavor = false }: {
  briefing: Briefing; update: (patch: Partial<Briefing>) => void; flavor?: boolean;
}) {
  return <div className="grid gap-3 sm:grid-cols-3">
    <Field label={flavor ? "Company (flavor)" : "Company"}>
      <input value={briefing.company} onChange={(e) => update({ company: e.target.value })} placeholder={flavor ? "e.g. Google" : "e.g. Stripe"} className="input" />
    </Field>
    <Field label="Position">
      <input value={briefing.position} onChange={(e) => update({ position: e.target.value })} placeholder="e.g. Backend engineer" className="input" />
    </Field>
    <Field label="Level">
      <select value={briefing.level} onChange={(e) => update({ level: e.target.value })} className="input">
        {LEVELS.map((level) => <option key={level}>{level}</option>)}
      </select>
    </Field>
  </div>;
}
