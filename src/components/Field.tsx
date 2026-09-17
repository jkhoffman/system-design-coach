export default function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-1.5"><span className="text-sm text-neutral-400">{label}</span>{children}</label>;
}
