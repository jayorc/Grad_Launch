type WorkflowStep = {
  step: string;
  title: string;
  description: string;
};

const steps: WorkflowStep[] = [
  {
    step: "01",
    title: "Upload your resume",
    description: "GradLaunch reads your resume and fills the profile for you."
  },
  {
    step: "02",
    title: "Set job preferences",
    description: "Choose roles, locations, work modes, and how strict the matching should be."
  },
  {
    step: "03",
    title: "Launch autopilot",
    description: "See matched jobs, start a draft, or hand the full form flow to the background agent."
  },
  {
    step: "04",
    title: "Track saved applications",
    description: "Every application stays organized with live status, generated answers, uploaded files, and handoff checkpoints."
  }
];

export function WorkflowSteps() {
  return (
    <div className="workflow-grid">
      {steps.map((item) => (
        <article className="workflow-card" key={item.step}>
          <span className="workflow-step">{item.step}</span>
          <h3>{item.title}</h3>
          <p className="muted">{item.description}</p>
        </article>
      ))}
    </div>
  );
}
