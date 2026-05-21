type StatCardProps = {
  label: string;
  value: number | string;
  hint: string;
};

export function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <article className="card stat-card">
      <p className="eyebrow">{label}</p>
      <h3>{value}</h3>
      <p className="section-description">{hint}</p>
    </article>
  );
}
