import { createId } from "../lib/id";
import { hashPassword } from "../lib/auth";
import { nowIso } from "../lib/time";
import { seedApplicationRuns, seedApplications, seedJobs, seedStudents } from "../data/seed";
import { AccountModel } from "../models/account-model";
import { ApplicationModel } from "../models/application-model";
import { ApplicationRunModel } from "../models/application-run-model";
import { JobModel } from "../models/job-model";
import { StudentModel } from "../models/student-model";

export async function seedDemoData() {
  for (const student of seedStudents) {
    await StudentModel.findOneAndUpdate(
      { id: student.id },
      { $setOnInsert: { ...student, email: student.email.toLowerCase() } },
      { upsert: true }
    );
  }

  const demoStudent = seedStudents[0];

  if (demoStudent) {
    await AccountModel.findOneAndUpdate(
      { email: demoStudent.email.toLowerCase() },
      {
        $setOnInsert: {
          id: createId("account"),
          studentId: demoStudent.id,
          email: demoStudent.email.toLowerCase(),
          passwordHash: await hashPassword("gradlaunch123")
        }
      },
      { upsert: true }
    );
  }

  for (const job of seedJobs) {
    await JobModel.findOneAndUpdate(
      { sourceUrl: job.sourceUrl },
      { $setOnInsert: job },
      { upsert: true }
    );
  }

  for (const application of seedApplications) {
    await ApplicationModel.findOneAndUpdate(
      { id: application.id },
      { $setOnInsert: application },
      { upsert: true }
    );
  }

  for (const run of seedApplicationRuns) {
    await ApplicationRunModel.findOneAndUpdate(
      { id: run.id },
      { $setOnInsert: run },
      { upsert: true }
    );
  }

  console.log(`[GradLaunch] Demo data ready at ${nowIso()}`);
}

