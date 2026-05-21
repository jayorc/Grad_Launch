import { STRICTNESS_THRESHOLDS } from "@gradlaunch/shared";
import type { Job, MatchStrictness, Recommendation, StudentProfile } from "@gradlaunch/shared";

export class MatchingService {
  scoreJob(student: StudentProfile, job: Job, strictness: MatchStrictness): Recommendation {
    let score = 0;
    const reasons: string[] = [];

    const normalizedJobTitle = job.title.toLowerCase();
    const matchedRole = student.targetRoles.find((role) =>
      normalizedJobTitle.includes(role.toLowerCase().split(" ")[0] ?? "")
    );

    if (matchedRole) {
      score += 30;
      reasons.push(`Role aligns with ${matchedRole}.`);
    }

    const skillOverlap = job.skills.filter((skill) =>
      student.skills.map((item) => item.toLowerCase()).includes(skill.toLowerCase())
    );

    score += Math.min(skillOverlap.length * 8, 32);

    if (skillOverlap.length > 0) {
      reasons.push(`${skillOverlap.length} relevant skills matched.`);
    }

    const locationMatch =
      student.preferredLocations.includes(job.location) ||
      student.preferredLocations.includes("Remote") && job.workMode === "remote";

    if (locationMatch) {
      score += 12;
      reasons.push("Preferred location or work mode matched.");
    }

    if (student.workModes.includes(job.workMode)) {
      score += 10;
    }

    if (job.minExperience <= 1) {
      score += 8;
    } else if (strictness === "broad") {
      score += 4;
      reasons.push("Slightly above experience band but still considered in broad mode.");
    }

    const degreeMatch = job.degreeRequirements.some((requirement) =>
      student.degree.toLowerCase().includes(requirement.toLowerCase().replace(".", ""))
    );

    if (degreeMatch) {
      score += 8;
      reasons.push("Degree requirement matched.");
    } else if (strictness === "strict") {
      score -= 10;
      reasons.push("Degree requirement mismatch lowered the score in strict mode.");
    }

    if (strictness === "strict" && job.workMode === "onsite" && !student.workModes.includes("onsite")) {
      score -= 20;
      reasons.push("Onsite requirement conflicts with the student's work preferences.");
    }

    if (strictness === "balanced" && job.workMode === "onsite" && !student.workModes.includes("onsite")) {
      score -= 8;
    }

    return {
      job,
      score: Math.max(0, Math.min(100, score)),
      reasons
    };
  }

  filterRecommended(student: StudentProfile, jobs: Job[], strictness: MatchStrictness): Recommendation[] {
    const threshold = STRICTNESS_THRESHOLDS[strictness];

    return jobs
      .map((job) => this.scoreJob(student, job, strictness))
      .filter((recommendation) => recommendation.score >= threshold)
      .sort((left, right) => right.score - left.score);
  }
}

