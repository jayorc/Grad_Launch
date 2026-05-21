import { APPLICATION_STATUS_LABELS, type ApplicationStatus } from "@gradlaunch/shared";

type StatusPillProps = {
  status: ApplicationStatus;
};

export function StatusPill({ status }: StatusPillProps) {
  return <span className={`status-pill status-${status}`}>{APPLICATION_STATUS_LABELS[status]}</span>;
}

